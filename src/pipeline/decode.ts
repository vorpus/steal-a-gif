import { createFile, DataStream, MP4BoxBuffer } from "mp4box";
import type { Movie, Sample } from "mp4box";
import type { Frame } from "./types";

/**
 * Decode a video file into frames.
 *
 * Preferred path: WebCodecs `VideoDecoder`, fed encoded chunks demuxed by
 * mp4box. This decodes *every* coded frame deterministically — no frames lost
 * to real-time playback the way the `<video>` + rVFC fallback drops them.
 *
 * Fallback: a `<video>` element + `requestVideoFrameCallback`, used when
 * WebCodecs is unavailable, the container isn't MP4/MOV, or the codec isn't
 * decodable in this browser (e.g. HEVC without hardware support).
 */
export async function decodeFrames(
  file: File,
  opts: { maxFrames?: number } = {},
): Promise<Frame[]> {
  const maxFrames = opts.maxFrames ?? 900;

  if (canTryWebCodecs(file)) {
    try {
      return await decodeViaWebCodecs(file, maxFrames);
    } catch (e) {
      console.warn("WebCodecs decode failed; falling back to <video>", e);
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await decodeViaVideoElement(url, maxFrames);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canTryWebCodecs(file: File): boolean {
  if (typeof VideoDecoder === "undefined") return false;
  return (
    /(mp4|quicktime|m4v|x-m4v)/i.test(file.type) ||
    /\.(mp4|mov|m4v)$/i.test(file.name)
  );
}

async function decodeViaWebCodecs(
  file: File,
  maxFrames: number,
): Promise<Frame[]> {
  const buf = await file.arrayBuffer();
  const mp4 = createFile();

  // Demux: parse the container, then pull every sample (encoded frame).
  const info = await new Promise<Movie>((resolve, reject) => {
    mp4.onError = (mod, msg) => reject(new Error(`mp4box ${mod}: ${msg}`));
    mp4.onReady = resolve;
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0));
    mp4.flush();
  });

  const track = info.videoTracks?.[0];
  if (!track) throw new Error("No video track in file");

  const samples: Sample[] = [];
  mp4.onSamples = (_id, _user, s) => samples.push(...s);
  mp4.setExtractionOptions(track.id, undefined, {
    nbSamples: Number.POSITIVE_INFINITY,
  });
  mp4.start();
  if (samples.length === 0) throw new Error("No samples extracted");

  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description: codecDescription(samples[0]),
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
    supported: false,
  }));
  if (!support.supported) {
    throw new Error(`Codec not decodable here: ${track.codec}`);
  }

  const frames: Frame[] = [];
  const pending: Promise<void>[] = [];
  let stopped = false;

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (stopped || frames.length + pending.length >= maxFrames) {
        frame.close();
        return;
      }
      const timestampUs = frame.timestamp;
      pending.push(
        createImageBitmap(frame)
          .then((bitmap) => {
            frames.push({ bitmap, timestampUs });
          })
          .finally(() => frame.close()),
      );
    },
    error: (e) => console.warn("VideoDecoder error", e),
  });
  decoder.configure(config);

  for (const s of samples) {
    if (frames.length + pending.length >= maxFrames) {
      stopped = true;
      break;
    }
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: (s.cts * 1e6) / s.timescale,
        duration: (s.duration * 1e6) / s.timescale,
        data: s.data!,
      }),
    );
  }

  await decoder.flush();
  await Promise.all(pending);
  decoder.close();

  if (frames.length === 0) throw new Error("Decoded zero frames");
  // Decoder emits in decode order; sort to presentation order by timestamp.
  frames.sort((a, b) => a.timestampUs - b.timestampUs);
  return frames;
}

/**
 * Pull the codec configuration record (avcC/hvcC/…) out of a sample's sample
 * entry and return it without the 8-byte box header — that's what
 * `VideoDecoder.configure({ description })` expects.
 */
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
  return new Uint8Array(stream.buffer, 8, stream.byteLength - 8);
}

async function decodeViaVideoElement(
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

  const frames: Frame[] = [];

  const hasRVFC = "requestVideoFrameCallback" in video;
  if (!hasRVFC) {
    throw new Error(
      "requestVideoFrameCallback unsupported; WebCodecs path needed for this browser",
    );
  }

  // Slower playback gives the capture loop time to grab every presented frame;
  // mediaTime is source-relative so timestamps stay correct.
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
      (video as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: typeof onFrame) => void;
      }).requestVideoFrameCallback(onFrame);
    };
    (video as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: typeof onFrame) => void;
    }).requestVideoFrameCallback(onFrame);
    video.onended = () => resolve();
  });

  video.pause();
  return frames;
}
