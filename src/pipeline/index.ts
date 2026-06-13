import { decodeFrames } from "./decode";
import { fingerprintFrames, dedupeFrames, detectLoop } from "./loopDetect";
import { autoCrop } from "./autoCrop";
import { estimateBackgroundColor, keyFlatBackground } from "./bgKey";
import { encodeGif } from "./encodeGif";
import type { Frame, Rect } from "./types";

export type Stage =
  | "decode"
  | "loop"
  | "autocrop"
  | "background"
  | "encode"
  | "done";

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

/**
 * Full extraction pipeline. Decodes the recording ONCE and derives every
 * requested size from the same loop + crop + matte, so all outputs are
 * identical except for resolution. (Decoding per size is non-deterministic —
 * frame capture is timing-dependent — and was producing mismatched exports.)
 *
 *   recording -> frames -> dedupe -> loop -> tight crop -> (key bg) -> GIFs
 */
export async function extractGifs(
  file: File,
  roughCrop: Rect,
  opts: { removeBackground: boolean; sizes: SizeSpec[] },
  onStage?: (stage: Stage, detail?: string) => void,
): Promise<ExtractResult> {
  onStage?.("decode");
  const raw = await decodeFrames(file);

  onStage?.("loop");
  const rawPrints = await fingerprintFrames(raw, roughCrop);
  const { frames, prints } = dedupeFrames(raw, rawPrints);
  const loop = detectLoop(frames, prints);
  const looped = frames.slice(loop.startIndex, loop.endIndex);

  onStage?.("autocrop");
  const tight = await autoCrop(looped, roughCrop);

  // Render the loop once at native crop resolution.
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
      fps: loop.fps,
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
    fps: loop.fps,
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
