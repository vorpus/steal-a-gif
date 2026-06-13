import type { Frame } from "./types";

/**
 * Decode a video file into frames.
 *
 * Strategy: prefer WebCodecs (fast, GPU-backed) when the file is a fragmented
 * MP4/WebM we can demux. The robust path for arbitrary screen-recording
 * containers (MOV from iOS, etc.) is to fall back to a <video> element and
 * grab frames via `requestVideoFrameCallback`. We ship the fallback first
 * because it works everywhere; WebCodecs is a later optimization.
 */
export async function decodeFrames(
  file: File,
  opts: { maxFrames?: number } = {},
): Promise<Frame[]> {
  const maxFrames = opts.maxFrames ?? 600;
  const url = URL.createObjectURL(file);
  try {
    return await decodeViaVideoElement(url, maxFrames);
  } finally {
    URL.revokeObjectURL(url);
  }
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

  // rVFC gives us real decoded frames with their media time, so we capture the
  // recording's native cadence rather than guessing an fps.
  const hasRVFC = "requestVideoFrameCallback" in video;
  if (!hasRVFC) {
    throw new Error(
      "requestVideoFrameCallback unsupported; WebCodecs path needed for this browser",
    );
  }

  // rVFC only fires for frames the compositor actually presents, so at 1x a
  // slow `createImageBitmap` makes us miss source frames. Playing slower gives
  // the capture loop time to grab every frame; `mediaTime` is source-relative
  // so the timestamps (and thus durations) stay correct regardless of rate.
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
