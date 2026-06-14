import { createFile, DataStream, MP4BoxBuffer } from "mp4box";
import type { Movie, Sample } from "mp4box";
import type { Frame, Rect } from "./types";

/**
 * How to crop+downscale each decoded frame at decode time, so we never hold
 * full-resolution frames in memory (the mobile OOM cause). `resize*` caps the
 * crop's edge to bound total memory across the whole window.
 */
interface CropSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  resizeW: number;
  resizeH: number;
}

function cropSpec(crop: Rect, nFrames: number): CropSpec {
  // Bound total RGBA bytes across all decoded frames to ~this budget by capping
  // each frame's longest edge. Small selections keep native resolution; only a
  // large box or a very long loop gets downscaled. The budget adapts to the
  // device's RAM where reported (Chrome/Android); Safari doesn't report it, so
  // we assume a conservative phone.
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const MEM_BUDGET = dm ? Math.max(120e6, Math.min(300e6, dm * 36e6)) : 150e6;
  const cap = Math.max(
    256,
    Math.min(1280, Math.floor(Math.sqrt(MEM_BUDGET / (4 * Math.max(1, nFrames))))),
  );
  const x = Math.max(0, Math.round(crop.x));
  const y = Math.max(0, Math.round(crop.y));
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  const scale = Math.min(1, cap / Math.max(w, h));
  return {
    x,
    y,
    w,
    h,
    resizeW: Math.max(1, Math.round(w * scale)),
    resizeH: Math.max(1, Math.round(h * scale)),
  };
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Crop+resize a frame to a small ImageBitmap, reliably across browsers.
 *
 * We must NOT crop a VideoFrame (or createImageBitmap options) directly:
 * Safari ignores the source rectangle and gives back the WHOLE frame (the
 * "entire image squished into a square" + still-OOM bug). Drawing a *canvas*
 * with a source rect IS honoured everywhere, so: draw the full frame onto a
 * reused full-size canvas (no source crop), then crop FROM that canvas. The
 * one full canvas is the only full-resolution buffer we keep.
 */
function cropFromFull(
  full: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D },
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  cs: CropSpec,
): Promise<ImageBitmap> {
  full.ctx.drawImage(source, 0, 0, srcW, srcH);
  const small = makeCanvas(cs.resizeW, cs.resizeH);
  const sctx = small.getContext("2d") as Canvas2D;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(full.canvas, cs.x, cs.y, cs.w, cs.h, 0, 0, cs.resizeW, cs.resizeH);
  return createImageBitmap(small);
}

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
  crop: Rect,
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

  // Crop+cap each frame to the selection at decode time so we never hold
  // full-resolution frames (the mobile out-of-memory cause).
  const cs = cropSpec(crop, picks.length);

  // Prefer WebCodecs when this browser can actually decode the codec.
  if (typeof VideoDecoder !== "undefined") {
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (support.supported) {
      try {
        const frames = await decodeWindowWebCodecs(config, samples, t0Us, t1Us, cs);
        console.info(
          `[steal-a-gif] accurate decode: WebCodecs · codec=${config.codec} · ${picks.length} samples → ${frames.length} frames @ ${cs.resizeW}×${cs.resizeH}`,
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
  const frames = await extractBySlowPlay(file, t0Us, t1Us, picks.length, onProgress, cs);
  console.info(
    `[steal-a-gif] accurate decode: slow-play · ${picks.length} samples → ${frames.length} frames @ ${cs.resizeW}×${cs.resizeH}`,
  );
  return frames;
}

async function decodeWindowWebCodecs(
  config: VideoDecoderConfig,
  samples: DemuxSample[],
  t0Us: number,
  t1Us: number,
  cs: CropSpec,
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
  let full: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } | null =
    null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const ts = frame.timestamp;
      if (ts >= t0Us && ts < t1Us) {
        if (!full) {
          const canvas = makeCanvas(frame.displayWidth, frame.displayHeight);
          full = { canvas, ctx: canvas.getContext("2d") as Canvas2D };
        }
        // cropFromFull draws the frame synchronously, so close it immediately.
        pending.push(
          cropFromFull(full, frame, frame.displayWidth, frame.displayHeight, cs).then(
            (bitmap) => {
              frames.push({ bitmap, timestampUs: ts });
            },
          ),
        );
      }
      frame.close();
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
  cs?: CropSpec,
): Promise<Frame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Timed out loading video")), 15000);
      video.onloadeddata = () => {
        clearTimeout(t);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(t);
        reject(new Error("This browser can't decode this video"));
      };
    });

    // Position just before the window so the first window frame is captured.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(t);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onErr);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("This browser can't decode this video"));
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out seeking video"));
      }, 8000);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onErr);
      video.currentTime = Math.max(0, t0Us / 1e6 - 0.001);
    });

    const frames: Frame[] = [];
    let lastTsUs = -1;
    video.playbackRate = 0.25;
    let full: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } | null =
      null;

    await new Promise<void>((resolve, reject) => {
      // Watchdog: if no new frame arrives for a while the decoder has stalled
      // (e.g. an HEVC frame the browser can't decode) — fail instead of hanging.
      let watchdog: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(
          () => reject(new Error("Video decode stalled")),
          6000,
        );
      };
      const finish = () => {
        clearTimeout(watchdog);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(watchdog);
        reject(new Error("This browser can't decode this video"));
      };
      video.onended = finish;
      const onFrame = async (_now: number, meta: { mediaTime: number }) => {
        const tUs = Math.round(meta.mediaTime * 1e6);
        if (tUs >= t1Us) {
          finish();
          return;
        }
        if (tUs > lastTsUs && tUs >= t0Us) {
          lastTsUs = tUs;
          let bitmap: ImageBitmap;
          if (cs) {
            if (!full) {
              const c = makeCanvas(video.videoWidth, video.videoHeight);
              full = { canvas: c, ctx: c.getContext("2d") as Canvas2D };
            }
            bitmap = await cropFromFull(full, video, video.videoWidth, video.videoHeight, cs);
          } else {
            bitmap = await createImageBitmap(video);
          }
          frames.push({ bitmap, timestampUs: tUs });
          onProgress?.(frames.length, totalEstimate);
          arm();
        }
        rvfc(video, onFrame);
      };
      arm();
      rvfc(video, onFrame);
      void video.play().catch(() => reject(new Error("Playback failed")));
    });

    video.pause();
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decide, at upload time, whether this browser can produce an accurate render
 * of this file — so we can warn or block BEFORE the user does all the work.
 *
 *  - "webcodecs": exact decode available (best path).
 *  - "fallback":  no WebCodecs for this codec, but the <video> element can
 *                 decode it (a quick mid-file probe succeeded). Works, slower.
 *  - "incompatible": neither works (e.g. HEVC in Firefox) — block with an error.
 */
export async function probeDecodability(
  file: File,
): Promise<"webcodecs" | "fallback" | "incompatible"> {
  const isMp4 =
    /(mp4|quicktime|m4v|x-m4v)/i.test(file.type) ||
    /\.(mp4|mov|m4v)$/i.test(file.name);
  if (!isMp4) return "fallback"; // non-MP4: only the <video> path applies

  let demuxed: Demuxed;
  try {
    demuxed = await demux(file);
  } catch {
    return "fallback";
  }

  if (typeof VideoDecoder !== "undefined") {
    const sup = await VideoDecoder.isConfigSupported(demuxed.config).catch(
      () => ({ supported: false }),
    );
    if (sup?.supported) return "webcodecs";
  }

  // WebCodecs can't decode this codec here. Verify the <video> fallback can,
  // by actually decoding a short mid-file window (representative of a render).
  const mid = demuxed.samples[Math.floor(demuxed.samples.length / 2)];
  try {
    const frames = await extractBySlowPlay(
      file,
      mid.ctsUs,
      mid.ctsUs + 350_000,
      4,
    );
    return frames.length > 0 ? "fallback" : "incompatible";
  } catch {
    return "incompatible";
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
