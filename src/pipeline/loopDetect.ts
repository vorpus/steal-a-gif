import type { Frame, LoopRange, Rect } from "./types";

/**
 * Find the loop in a screen recording of a looping animation.
 *
 * A screen capture of a looping GIF contains N full cycles plus partial
 * cycles at the head and tail, often with junk frames (a finger lifting off,
 * the share sheet animating away). We want exactly one clean cycle.
 *
 * Approach:
 *   1. Reduce every frame to a small grayscale "fingerprint" (default 16x16)
 *      inside the user's crop rect, so comparison is cheap and noise-tolerant.
 *   2. For each candidate period p, measure how well frame[i] matches
 *      frame[i+p] across the clip. A true loop period minimizes this
 *      "wrap-around" error — it's autocorrelation on frame fingerprints.
 *   3. Pick the best period, then choose the start offset whose seam
 *      (last-frame -> first-frame transition) is smoothest.
 */
export async function detectLoop(
  frames: Frame[],
  crop: Rect,
  opts: { fingerprintSize?: number; minPeriod?: number } = {},
): Promise<LoopRange> {
  const fpSize = opts.fingerprintSize ?? 16;
  const minPeriod = opts.minPeriod ?? 4;
  const n = frames.length;
  if (n < minPeriod * 2) {
    return { startIndex: 0, endIndex: n, fps: estimateFps(frames), seamError: Infinity };
  }

  const prints = await Promise.all(
    frames.map((f) => fingerprint(f.bitmap, crop, fpSize)),
  );

  const maxPeriod = Math.floor(n / 2);
  let bestPeriod = minPeriod;
  let bestPeriodError = Infinity;

  for (let p = minPeriod; p <= maxPeriod; p++) {
    let err = 0;
    let count = 0;
    for (let i = 0; i + p < n; i++) {
      err += l1(prints[i], prints[i + p]);
      count++;
    }
    // Normalize so longer periods (fewer comparisons) aren't unfairly favored.
    const meanErr = err / count;
    if (meanErr < bestPeriodError) {
      bestPeriodError = meanErr;
      bestPeriod = p;
    }
  }

  // With the period fixed, slide a window of length `bestPeriod` and pick the
  // start whose seam frame[start+period-1] -> frame[start] is cleanest.
  let bestStart = 0;
  let bestSeam = Infinity;
  for (let start = 0; start + bestPeriod < n; start++) {
    const seam = l1(prints[start + bestPeriod - 1], prints[start]);
    if (seam < bestSeam) {
      bestSeam = seam;
      bestStart = start;
    }
  }

  return {
    startIndex: bestStart,
    endIndex: bestStart + bestPeriod,
    fps: estimateFps(frames),
    seamError: bestSeam,
  };
}

/** Downsample a crop region to an SxS grayscale Float32 fingerprint in [0,1]. */
async function fingerprint(
  bitmap: ImageBitmap,
  crop: Rect,
  size: number,
): Promise<Float32Array> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    size,
    size,
  );
  const { data } = ctx.getImageData(0, 0, size, size);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return out;
}

function l1(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function estimateFps(frames: Frame[]): number {
  if (frames.length < 2) return 30;
  const span = frames[frames.length - 1].timestampUs - frames[0].timestampUs;
  if (span <= 0) return 30;
  return ((frames.length - 1) / span) * 1e6;
}
