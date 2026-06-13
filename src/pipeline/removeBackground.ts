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

/** Apply the matte produced for the first frame is NOT valid across frames;
 * background removal must run per frame. This helper batches with a small
 * concurrency limit so we don't blow up GPU memory on long loops. */
export async function removeBackgroundBatch(
  frames: (OffscreenCanvas | HTMLCanvasElement)[],
  concurrency = 2,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const out: Blob[] = new Array(frames.length);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (next < frames.length) {
      const i = next++;
      out[i] = await removeFrameBackground(frames[i]);
      done++;
      onProgress?.(done, frames.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, frames.length) }, worker),
  );
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
