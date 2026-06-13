import type { Frame, LoopRange, Rect } from "./types";

const FP_SIZE = 16;

/**
 * Reduce every frame to a small grayscale fingerprint inside the crop rect, so
 * all the comparison math downstream is cheap and noise-tolerant.
 */
export async function fingerprintFrames(
  frames: Frame[],
  crop: Rect,
  size = FP_SIZE,
): Promise<Float32Array[]> {
  return Promise.all(frames.map((f) => fingerprint(f.bitmap, crop, size)));
}

/**
 * Collapse runs of near-identical frames.
 *
 * A screen recording captures at the device rate (often 60fps) while the GIF
 * plays much slower (~10fps), so each animation frame is captured several
 * times in a row. Those duplicates wreck loop detection — adjacent identical
 * frames look like a perfect 1-frame loop. Dropping them recovers the GIF's
 * actual frame sequence (and its real cadence, via the kept timestamps).
 */
export function dedupeFrames(
  frames: Frame[],
  prints: Float32Array[],
  opts: { epsilon?: number } = {},
): { frames: Frame[]; prints: Float32Array[] } {
  const eps = opts.epsilon ?? 0.004; // mean per-pixel delta below this == dup
  if (frames.length === 0) return { frames, prints };

  // Keep the first frame of each run of near-identical frames. A kept frame's
  // duration is the time until the NEXT kept frame — so merged duplicates
  // (whether capture dupes or a held animation frame) contribute their real
  // on-screen time, and playback speed is preserved exactly.
  const keptIdx: number[] = [0];
  for (let i = 1; i < frames.length; i++) {
    if (l1(prints[i], prints[keptIdx[keptIdx.length - 1]]) > eps) {
      keptIdx.push(i);
    }
  }

  const outF: Frame[] = [];
  const outP: Float32Array[] = [];
  for (let k = 0; k < keptIdx.length; k++) {
    const i = keptIdx[k];
    const nextTs =
      k + 1 < keptIdx.length
        ? frames[keptIdx[k + 1]].timestampUs
        : frames[frames.length - 1].timestampUs +
          medianFrameStep(frames); // tail frame: assume one more step
    outF.push({
      ...frames[i],
      durationUs: Math.max(1, nextTs - frames[i].timestampUs),
    });
    outP.push(prints[i]);
  }
  return { frames: outF, prints: outP };
}

/** Median raw capture step in µs — used to give the final frame a duration. */
function medianFrameStep(frames: Frame[]): number {
  if (frames.length < 2) return 33_333; // ~30fps guess
  const steps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].timestampUs - frames[i - 1].timestampUs;
    if (d > 0) steps.push(d);
  }
  if (steps.length === 0) return 33_333;
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

/**
 * Find the loop in the (deduped) frame sequence.
 *
 * For each candidate period p we measure two things over the clip:
 *   E(p) = how well frame[i] matches frame[i+p]  (low == it really repeats)
 *   D(p) = how much the window [0,p) varies from its first frame
 *          (high == the window covers the *whole* animation, not a fragment)
 *
 * We maximize `D(p) - k*E(p)`: a real loop both repeats cleanly AND spans the
 * full motion. This is what stops the search collapsing onto a tiny period of
 * nearly-static frames. Scanning ascending with strict improvement means that
 * when the true period and its multiples tie, we keep the shortest.
 */
export function detectLoop(
  frames: Frame[],
  prints: Float32Array[],
  opts: { minPeriod?: number; seamWeight?: number } = {},
): LoopRange {
  const minPeriod = opts.minPeriod ?? 2;
  const k = opts.seamWeight ?? 3;
  const n = frames.length;
  if (n < minPeriod * 2) {
    return {
      startIndex: 0,
      endIndex: n,
      fps: estimateFps(frames),
      seamError: Infinity,
    };
  }

  const maxPeriod = Math.floor(n / 2);
  let bestPeriod = minPeriod;
  let bestScore = -Infinity;

  for (let p = minPeriod; p <= maxPeriod; p++) {
    let err = 0;
    let count = 0;
    for (let i = 0; i + p < n; i++) {
      err += l1(prints[i], prints[i + p]);
      count++;
    }
    const E = err / count;

    let D = 0;
    for (let i = 1; i < p; i++) D = Math.max(D, l1(prints[i], prints[0]));

    const score = D - k * E;
    if (score > bestScore + 1e-6) {
      bestScore = score;
      bestPeriod = p;
    }
  }

  // With the period fixed, slide a window and pick the start whose seam
  // (last frame -> first frame) is smoothest, so the GIF loops without a jump.
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
    out[i] =
      (0.299 * data[i * 4] +
        0.587 * data[i * 4 + 1] +
        0.114 * data[i * 4 + 2]) /
      255;
  }
  return out;
}

function l1(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Median inter-frame delta of the (deduped) frames -> source animation fps. */
function estimateFps(frames: Frame[]): number {
  if (frames.length < 2) return 12;
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    deltas.push(frames[i].timestampUs - frames[i - 1].timestampUs);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1];
  if (median <= 0) return 12;
  return 1e6 / median;
}
