import type { Frame, Rect } from "./types";

/**
 * Tighten the user's approximate crop down to the animation's true bounds.
 *
 * The insight: inside the rough rectangle, the app's static chrome (rounded
 * corners, padding, a caption bar) doesn't change between frames, while the
 * animation does. We build a per-pixel "motion map" — the variance of each
 * pixel across the loop — and take the bounding box of everything that moves.
 *
 * This both removes dead app background AND finds the real GIF size, which is
 * what we want for the "crop down to actual size" step.
 */
export async function autoCrop(
  frames: Frame[],
  roughCrop: Rect,
  opts: { threshold?: number; padding?: number; sampleStride?: number } = {},
): Promise<Rect> {
  const threshold = opts.threshold ?? 0.02; // normalized variance
  const padding = opts.padding ?? 2;
  const stride = opts.sampleStride ?? Math.max(1, Math.floor(frames.length / 24));

  const w = Math.round(roughCrop.width);
  const h = Math.round(roughCrop.height);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Online mean/variance (Welford) of grayscale per pixel across sampled frames.
  const mean = new Float32Array(w * h);
  const m2 = new Float32Array(w * h);
  let count = 0;

  for (let f = 0; f < frames.length; f += stride) {
    ctx.drawImage(
      frames[f].bitmap,
      roughCrop.x,
      roughCrop.y,
      roughCrop.width,
      roughCrop.height,
      0,
      0,
      w,
      h,
    );
    const { data } = ctx.getImageData(0, 0, w, h);
    count++;
    for (let i = 0; i < w * h; i++) {
      const gray =
        (0.299 * data[i * 4] +
          0.587 * data[i * 4 + 1] +
          0.114 * data[i * 4 + 2]) /
        255;
      const delta = gray - mean[i];
      mean[i] += delta / count;
      m2[i] += delta * (gray - mean[i]);
    }
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const variance = m2[y * w + x] / Math.max(1, count - 1);
      if (variance > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // No motion detected → fall back to the user's rectangle unchanged.
  if (maxX < minX || maxY < minY) return roughCrop;

  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(w - 1, maxX + padding);
  maxY = Math.min(h - 1, maxY + padding);

  return {
    x: roughCrop.x + minX,
    y: roughCrop.y + minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
