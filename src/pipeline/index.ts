import { decodeFrames } from "./decode";
import { detectLoop } from "./loopDetect";
import { autoCrop } from "./autoCrop";
import { removeBackgroundBatch } from "./removeBackground";
import { encodeGif } from "./encodeGif";
import type { ExportOptions, Frame, Rect } from "./types";

export type Stage =
  | "decode"
  | "loop"
  | "autocrop"
  | "background"
  | "encode"
  | "done";

export interface RunResult {
  gif: Blob;
  finalCrop: Rect;
  frameCount: number;
  fps: number;
}

/**
 * Full extraction pipeline:
 *   recording -> frames -> loop -> tight crop -> (bg removal) -> GIF
 */
export async function extractGif(
  file: File,
  roughCrop: Rect,
  exportOpts: ExportOptions,
  onStage?: (stage: Stage, detail?: string) => void,
): Promise<RunResult> {
  onStage?.("decode");
  const frames = await decodeFrames(file);

  onStage?.("loop");
  const loop = await detectLoop(frames, roughCrop);
  const looped = frames.slice(loop.startIndex, loop.endIndex);

  onStage?.("autocrop");
  const tight = await autoCrop(looped, roughCrop);

  const fps = exportOpts.fps || loop.fps;
  const rendered = renderFrames(looped, tight, exportOpts.maxEdge);

  let imageDatas: ImageData[];
  if (exportOpts.removeBackground) {
    onStage?.("background");
    const blobs = await removeBackgroundBatch(rendered.canvases, 2, (d, t) =>
      onStage?.("background", `${d}/${t}`),
    );
    imageDatas = await Promise.all(blobs.map(blobToImageData));
  } else {
    imageDatas = rendered.canvases.map((c) =>
      c.getContext("2d")!.getImageData(0, 0, c.width, c.height),
    );
  }

  onStage?.("encode");
  const gif = await encodeGif(imageDatas, { ...exportOpts, fps });

  onStage?.("done");
  return { gif, finalCrop: tight, frameCount: looped.length, fps };
}

function renderFrames(
  frames: Frame[],
  crop: Rect,
  maxEdge: number | null,
): { canvases: OffscreenCanvas[] } {
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(crop.width, crop.height))
    : 1;
  const w = Math.max(1, Math.round(crop.width * scale));
  const h = Math.max(1, Math.round(crop.height * scale));

  const canvases = frames.map((f) => {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      f.bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      w,
      h,
    );
    return c;
  });
  return { canvases };
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export * from "./types";
