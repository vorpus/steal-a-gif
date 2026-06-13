import { createFile, DataStream, MP4BoxBuffer } from "mp4box";
import type { Movie, Sample } from "mp4box";
import type { Frame } from "./types";

/**
 * Decoding has two modes:
 *
 *  - PREVIEW (`decodeForPreview`): play the clip and grab frames via
 *    requestVideoFrameCallback. Fast and universal (uses the browser's native
 *    decode, so HEVC works), but drops frames under load. That's fine — it
 *    only drives the scrubber and loop preview.
 *
 *  - ACCURATE (`extractAccurateRange`): for the trimmed range only, get every
 *    frame with correct timing. Tries WebCodecs (fast, H.264). When the codec
 *    isn't WebCodecs-decodable (e.g. HEVC on most Chrome builds), it demuxes
 *    the exact frame timestamps with mp4box and SEEKS the <video> to each one
 *    — deterministic, no drops, and uses native HEVC decode.
 */

interface DemuxSample {
  /** Composition (presentation) time, µs. */
  ctsUs: number;
  /** Frame duration, µs. */
  durUs: number;
  isSync: boolean;
  data: Uint8Array;
}

interface Demuxed {
  config: VideoDecoderConfig;
  /** Samples in DECODE order (as delivered) — required for VideoDecoder. */
  samples: DemuxSample[];
}

// ---------------------------------------------------------------------------
// Preview decode (fast, lossy, universal)
// ---------------------------------------------------------------------------

export async function decodeForPreview(
  file: File,
  opts: { maxFrames?: number } = {},
): Promise<Frame[]> {
  const maxFrames = opts.maxFrames ?? 900;
  const url = URL.createObjectURL(file);
  try {
    return await captureByPlayback(url, maxFrames);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function captureByPlayback(
  url: string,
  maxFrames: number,
): Promise<Frame[]> {
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Failed to load video metadata"));
  });

  if (!("requestVideoFrameCallback" in video)) {
    throw new Error("requestVideoFrameCallback unsupported in this browser");
  }

  const frames: Frame[] = [];
  // Slower playback lets the capture loop keep up; mediaTime is source-relative
  // so timestamps stay correct regardless of rate.
  video.playbackRate = 0.5;
  await video.play();

  await new Promise<void>((resolve) => {
    const onFrame = async (
      _now: number,
      meta: { mediaTime: number },
    ): Promise<void> => {
      if (frames.length >= maxFrames || video.ended) {
        resolve();
        return;
      }
      const bitmap = await createImageBitmap(video);
      frames.push({ bitmap, timestampUs: Math.round(meta.mediaTime * 1e6) });
      rvfc(video, onFrame);
    };
    rvfc(video, onFrame);
    video.onended = () => resolve();
  });

  video.pause();
  return frames;
}

function rvfc(
  video: HTMLVideoElement,
  cb: (now: number, meta: { mediaTime: number }) => void,
): void {
  (
    video as HTMLVideoElement & {
      requestVideoFrameCallback: (c: typeof cb) => void;
    }
  ).requestVideoFrameCallback(cb);
}

// ---------------------------------------------------------------------------
// Accurate range extraction (every frame, correct timing)
// ---------------------------------------------------------------------------

export async function extractAccurateRange(
  file: File,
  t0Us: number,
  t1Us: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Frame[]> {
  let demuxed: Demuxed;
  try {
    demuxed = await demux(file);
  } catch (e) {
    console.warn("demux failed; caller should fall back", e);
    return [];
  }

  const { config, samples } = demuxed;
  const picks = samples
    .filter((s) => s.ctsUs >= t0Us && s.ctsUs < t1Us)
    .sort((a, b) => a.ctsUs - b.ctsUs);
  if (picks.length === 0) return [];

  // Prefer WebCodecs when this browser can actually decode the codec.
  if (typeof VideoDecoder !== "undefined") {
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (support.supported) {
      try {
        const frames = await decodeWindowWebCodecs(config, samples, t0Us, t1Us);
        console.info(
          `[steal-a-gif] accurate decode: WebCodecs · codec=${config.codec} · ${picks.length} samples in window → ${frames.length} frames`,
        );
        return frames;
      } catch (e) {
        console.warn("WebCodecs window decode failed; seeking instead", e);
      }
    } else {
      console.info(
        `[steal-a-gif] WebCodecs can't decode ${config.codec}; using seek path`,
      );
    }
  }

  // Universal fallback: slow-playback capture (handles HEVC, doesn't depend on
  // flaky per-seek precision).
  const frames = await extractBySlowPlay(file, t0Us, t1Us, picks.length, onProgress);
  console.info(
    `[steal-a-gif] accurate decode: slow-play · ${picks.length} samples in window → ${frames.length} frames`,
  );
  return frames;
}

async function decodeWindowWebCodecs(
  config: VideoDecoderConfig,
  samples: DemuxSample[],
  t0Us: number,
  t1Us: number,
): Promise<Frame[]> {
  // Feed through the last sample presenting before t1. Feed from sample 0 (the
  // initial IDR with full parameter sets) rather than a mid-stream keyframe —
  // HEVC "sync" samples mid-stream can lack the parameter sets the decoder
  // needs, which shows up as a generic "Decoder failure".
  let endIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].ctsUs < t1Us) endIdx = i;
  }

  const frames: Frame[] = [];
  const pending: Promise<void>[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const ts = frame.timestamp;
      if (ts >= t0Us && ts < t1Us) {
        pending.push(
          createImageBitmap(frame)
            .then((bitmap) => {
              frames.push({ bitmap, timestampUs: ts });
            })
            .finally(() => frame.close()),
        );
      } else {
        frame.close();
      }
    },
    error: (e) => console.warn("VideoDecoder error", e),
  });
  decoder.configure(config);

  for (let i = 0; i <= endIdx; i++) {
    const s = samples[i];
    decoder.decode(
      new EncodedVideoChunk({
        type: s.isSync ? "key" : "delta",
        timestamp: s.ctsUs,
        duration: s.durUs,
        data: s.data,
      }),
    );
  }
  await decoder.flush();
  await Promise.all(pending);
  decoder.close();

  if (frames.length === 0) throw new Error("WebCodecs produced no frames");
  frames.sort((a, b) => a.timestampUs - b.timestampUs);
  return frames;
}

/**
 * Capture every frame in [t0,t1) by playing the window at a low rate.
 *
 * Seeking per frame is unreliable (Safari blob seeks return stale frames). At
 * 0.25× the compositor presents every source frame with plenty of wall-clock
 * time to grab it via requestVideoFrameCallback, so nothing is skipped and we
 * don't depend on per-seek precision. We capture once per distinct mediaTime.
 */
async function extractBySlowPlay(
  file: File,
  t0Us: number,
  t1Us: number,
  totalEstimate: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Frame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video"));
    });

    // Position just before the window so the first window frame is captured.
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.max(0, t0Us / 1e6 - 0.001);
    });

    const frames: Frame[] = [];
    let lastTsUs = -1;
    video.playbackRate = 0.25;

    await new Promise<void>((resolve) => {
      const onFrame = async (_now: number, meta: { mediaTime: number }) => {
        const tUs = Math.round(meta.mediaTime * 1e6);
        if (tUs >= t1Us) {
          resolve();
          return;
        }
        if (tUs > lastTsUs && tUs >= t0Us) {
          lastTsUs = tUs;
          const bitmap = await createImageBitmap(video);
          frames.push({ bitmap, timestampUs: tUs });
          onProgress?.(frames.length, totalEstimate);
        }
        rvfc(video, onFrame);
      };
      rvfc(video, onFrame);
      video.onended = () => resolve();
      void video.play();
    });

    video.pause();
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Demux (mp4box)
// ---------------------------------------------------------------------------

async function demux(file: File): Promise<Demuxed> {
  const buf = await file.arrayBuffer();
  const mp4 = createFile();

  // Extraction must be enabled and start()ed BEFORE the final flush() — flush
  // is what emits the buffered samples. (Doing flush first yields zero
  // samples.) The whole file is appended at once, so onReady fires during
  // appendBuffer and we set everything up there, then flush to drain.
  const { track, raw } = await new Promise<{ track: Movie["videoTracks"][number]; raw: Sample[] }>(
    (resolve, reject) => {
      const collected: Sample[] = [];
      mp4.onError = (mod, msg) => reject(new Error(`mp4box ${mod}: ${msg}`));
      mp4.onSamples = (_id, _user, s) => collected.push(...s);
      mp4.onReady = (info) => {
        const t = info.videoTracks?.[0];
        if (!t) {
          reject(new Error("No video track in file"));
          return;
        }
        mp4.setExtractionOptions(t.id, undefined, {
          nbSamples: Number.POSITIVE_INFINITY,
        });
        mp4.start();
        mp4.flush();
        resolve({ track: t, raw: collected });
      };
      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0));
      mp4.flush();
    },
  );

  if (raw.length === 0) throw new Error("No samples extracted");

  const samples: DemuxSample[] = raw.map((s) => ({
    ctsUs: (s.cts * 1e6) / s.timescale,
    durUs: (s.duration * 1e6) / s.timescale,
    isSync: s.is_sync,
    // COPY the bytes: mp4box reuses its internal sample buffers, so holding a
    // reference and feeding it later gives the decoder garbage ("Decoder
    // failure"). A standalone copy is stable until we decode.
    data: new Uint8Array(s.data!),
  }));

  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description: codecDescription(raw[0]),
  };

  return { config, samples };
}

/** Codec config record (avcC/hvcC/…) without the 8-byte box header. */
function codecDescription(sample: Sample): Uint8Array {
  const entry = sample.description as {
    avcC?: { write(s: DataStream): void };
    hvcC?: { write(s: DataStream): void };
    vpcC?: { write(s: DataStream): void };
    av1C?: { write(s: DataStream): void };
  };
  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  if (!box) throw new Error("No codec description (avcC/hvcC) in sample entry");
  const stream = new DataStream(); // big-endian, dynamic size
  box.write(stream);
  // Copy the payload into a fresh zero-offset buffer. A subarray view with a
  // byteOffset of 8 (and over-allocated backing buffer) can trip up decoders;
  // a clean standalone array is safest for VideoDecoder.configure.
  const view = new Uint8Array(stream.buffer, 8, stream.byteLength - 8);
  return new Uint8Array(view);
}
