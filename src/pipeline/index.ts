import { decodeFrames } from "./decode";
import { fingerprintFrames, dedupeFrames, detectLoop } from "./loopDetect";
import { autoCrop } from "./autoCrop";
import { estimateBackgroundColor, keyFlatBackground } from "./bgKey";
import { encodeGif } from "./encodeGif";
import type { Frame, Rect } from "./types";

export type Stage = "background" | "encode" | "done";

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
  frames: Frame[];
  fps: number;
  width: number;
  height: number;
  /** Auto-suggested loop, as indices into `frames`. The user refines it. */
  suggested: { start: number; end: number };
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
  const raw = await decodeFrames(file);
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
  };
}

/**
 * Turn a user-chosen frame range + crop into downloadable GIFs. All output
 * sizes derive from the same matte so they always agree.
 */
export async function renderGifs(
  frames: Frame[],
  range: { start: number; end: number },
  crop: Rect,
  opts: {
    removeBackground: boolean;
    autoTighten: boolean;
    fps: number;
    sizes: SizeSpec[];
  },
  onStage?: (stage: Stage, detail?: string) => void,
): Promise<ExtractResult> {
  const looped = frames.slice(range.start, range.end);
  if (looped.length === 0) throw new Error("Empty loop range");

  const tight = opts.autoTighten ? await autoCrop(looped, crop) : crop;

  let base = renderFrames(looped, tight).map((c) =>
    c.getContext("2d")!.getImageData(0, 0, c.width, c.height),
  );

  if (opts.removeBackground) {
    onStage?.("background");
    const bg = estimateBackgroundColor(base[0]);
    base = base.map((f) => keyFlatBackground(f, bg));
  }

  onStage?.("encode");
  const outputs: SizedResult[] = [];
  for (const size of opts.sizes) {
    const sized = size.maxEdge
      ? base.map((f) => downscaleImageData(f, size.maxEdge!))
      : base;
    const gif = await encodeGif(sized, {
      maxEdge: size.maxEdge,
      fps: opts.fps,
      removeBackground: opts.removeBackground,
      maxBytes: size.maxBytes,
    });
    outputs.push({ label: size.label, gif, bytes: gif.size });
  }

  onStage?.("done");
  return {
    outputs,
    finalCrop: tight,
    frameCount: looped.length,
    fps: opts.fps,
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
