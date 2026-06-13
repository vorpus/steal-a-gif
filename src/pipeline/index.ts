import { decodeForPreview, extractAccurateRange } from "./decode";
import { fingerprintFrames, dedupeFrames, detectLoop } from "./loopDetect";
import { autoCrop } from "./autoCrop";
import { estimateBackgroundColor, keyFlatBackground } from "./bgKey";
import { encodeGif } from "./encodeGif";
import type { Frame, Rect } from "./types";

export type Stage = "extract" | "background" | "encode" | "done";

/** One requested output size. */
export interface SizeSpec {
  label: string;
  /** Longest edge in px; `null` keeps native crop size. */
  maxEdge: number | null;
  /** Hard byte ceiling (Slack animated emoji = 128KB); `null` for none. */
  maxBytes: number | null;
}

export interface SizedResult {
  label: string;
  gif: Blob;
  bytes: number;
}

export interface ExtractResult {
  outputs: SizedResult[];
  finalCrop: Rect;
  frameCount: number;
  fps: number;
}

/** Decoded, de-duplicated frames plus a suggested loop range to start from. */
export interface Prepared {
  /** Preview frames (fast, possibly lossy) that drive the scrubber/preview. */
  frames: Frame[];
  fps: number;
  width: number;
  height: number;
  /** Auto-suggested loop, as indices into `frames`. The user refines it. */
  suggested: { start: number; end: number };
  /** Kept so the final render can re-decode the chosen range accurately. */
  file: File;
}

/**
 * Decode the recording ONCE and collapse capture duplicates, so the UI can
 * show a scrubber of the true animation frames and a live loop preview.
 *
 * Loop detection is only used to seed the suggested range — the user owns the
 * final start/end (auto-detection can't tell the animation from, say, swiping
 * Control Center open at the end of the clip).
 */
export async function prepareFrames(file: File): Promise<Prepared> {
  // Fast/lossy decode is fine here — these frames only drive the UI.
  const raw = await decodeForPreview(file);
  if (raw.length === 0) throw new Error("No frames decoded from this file");

  const width = raw[0].bitmap.width;
  const height = raw[0].bitmap.height;
  const full: Rect = { x: 0, y: 0, width, height };

  // Fingerprint over the whole frame so dedupe reacts to any change.
  const prints = await fingerprintFrames(raw, full);
  const { frames, prints: dprints } = dedupeFrames(raw, prints);
  const loop = detectLoop(frames, dprints);

  return {
    frames,
    fps: loop.fps,
    width,
    height,
    suggested: { start: loop.startIndex, end: loop.endIndex },
    file,
  };
}

/**
 * Turn a user-chosen frame range + crop into downloadable GIFs.
 *
 * The preview frames may have dropped frames (fast lossy decode), so for the
 * final render we map the chosen range to a TIME window and re-decode it
 * accurately (every frame, real timing). If accurate decode yields nothing
 * (e.g. a non-MP4 the demuxer can't read), we fall back to the preview slice.
 */
export async function renderGifs(
  prepared: Prepared,
  range: { start: number; end: number },
  crop: Rect,
  opts: {
    removeBackground: boolean;
    autoTighten: boolean;
    sizes: SizeSpec[];
  },
  onStage?: (stage: Stage, detail?: string) => void,
): Promise<ExtractResult> {
  const preview = prepared.frames;
  if (range.end <= range.start) throw new Error("Empty loop range");

  // Time window of the selected loop, from the preview frames' timestamps.
  const startF = preview[range.start];
  const endF = preview[range.end - 1];
  const fallbackMs0 = 1000 / prepared.fps;
  const t0Us = startF.timestampUs;
  const t1Us = endF.timestampUs + (endF.durationUs ?? fallbackMs0 * 1000);

  onStage?.("extract");
  const accurate = await extractAccurateRange(
    prepared.file,
    t0Us,
    t1Us,
    (d, t) => onStage?.("extract", `${d}/${t}`),
  );

  let looped: Frame[];
  if (accurate.length >= 2) {
    // Collapse held duplicates among the full-rate frames, preserving the real
    // per-frame durations, then pin the last frame's duration so the loop's
    // total time matches the selected window exactly.
    const full: Rect = {
      x: 0,
      y: 0,
      width: accurate[0].bitmap.width,
      height: accurate[0].bitmap.height,
    };
    const prints = await fingerprintFrames(accurate, full);
    looped = dedupeFrames(accurate, prints).frames;
    const last = looped[looped.length - 1];
    last.durationUs = Math.max(1, t1Us - last.timestampUs);
  } else {
    looped = preview.slice(range.start, range.end);
  }

  const tight = opts.autoTighten ? await autoCrop(looped, crop) : crop;

  let base = renderFrames(looped, tight).map((c) =>
    c.getContext("2d")!.getImageData(0, 0, c.width, c.height),
  );

  if (opts.removeBackground) {
    onStage?.("background");
    const bg = estimateBackgroundColor(base[0]);
    base = base.map((f) => keyFlatBackground(f, bg));
  }

  // Real per-frame on-screen time (ms) from the recording, so the GIF keeps
  // the source cadence instead of a single guessed fps.
  const fallbackMs = 1000 / prepared.fps;
  const delaysMs = looped.map((f) =>
    f.durationUs ? f.durationUs / 1000 : fallbackMs,
  );

  onStage?.("encode");
  const outputs: SizedResult[] = [];
  for (const size of opts.sizes) {
    const sized = size.maxEdge
      ? base.map((f) => downscaleImageData(f, size.maxEdge!))
      : base;
    const gif = await encodeGif(
      sized,
      {
        maxEdge: size.maxEdge,
        fps: prepared.fps,
        removeBackground: opts.removeBackground,
        maxBytes: size.maxBytes,
      },
      delaysMs,
    );
    outputs.push({ label: size.label, gif, bytes: gif.size });
  }

  onStage?.("done");
  return {
    outputs,
    finalCrop: tight,
    frameCount: looped.length,
    fps: prepared.fps,
  };
}

function renderFrames(frames: Frame[], crop: Rect): OffscreenCanvas[] {
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  return frames.map((f) => {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(f.bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
    return c;
  });
}

function downscaleImageData(img: ImageData, maxEdge: number): ImageData {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export * from "./types";
