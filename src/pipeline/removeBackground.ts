import { removeBackground } from "@imgly/background-removal";

/**
 * Strip the app background from a single cropped frame.
 *
 * v1 uses @imgly/background-removal (ISNet) with the WebGPU backend when
 * available. Because it treats each frame independently, expect some edge
 * flicker across the loop — see README for the temporal-smoothing / RVM plan.
 *
 * Input/Output are RGBA canvases so the caller stays in pixel-space and can
 * feed results straight into the GIF encoder.
 */
export async function removeFrameBackground(
  source: OffscreenCanvas | HTMLCanvasElement,
): Promise<Blob> {
  const blob = await canvasToBlob(source);
  return removeBackground(blob, {
    device: "gpu",
    model: "isnet_fp16",
    output: { format: "image/png" },
  });
}

/**
 * Background removal must run per frame (a first-frame matte isn't valid for
 * later frames). @imgly/background-removal holds a single global onnxruntime
 * session, so calls MUST be serialized — running two concurrently throws
 * "Session already started". We process strictly one at a time.
 */
export async function removeBackgroundBatch(
  frames: (OffscreenCanvas | HTMLCanvasElement)[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const out: Blob[] = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    out[i] = await removeFrameBackground(frames[i]);
    onProgress?.(i + 1, frames.length);
  }
  return out;
}

function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
}
