/**
 * Flat-background removal for sticker-picker captures.
 *
 * Sticker apps (WeChat, XHS, …) render the animation on a SOLID, CONNECTED
 * background color. An AI matting model (ISNet/RMBG) is the wrong tool here:
 * it does salient-object detection and routinely drops stylized characters
 * while keeping a high-contrast prop.
 *
 * Instead we flood-fill the background starting from the frame border. Two
 * properties make this robust:
 *   - It only removes pixels CONNECTED to the edge, so an interior shape whose
 *     outline happens to be close in color to the background (e.g. a dark
 *     outline on a dark-green bg) is never eaten — the subject's body blocks
 *     the fill from ever reaching it.
 *   - The seed color is constant across frames, so there's no per-frame
 *     flicker the way independent AI mattes have.
 */

export interface BgColor {
  r: number;
  g: number;
  b: number;
}

/** Median color of the frame's border pixels — robust to a subject that
 *  touches an edge (the median ignores those outliers). */
export function estimateBackgroundColor(img: ImageData): BgColor {
  const { width: w, height: h, data } = img;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    sample(x, 0);
    sample(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    sample(0, y);
    sample(w - 1, y);
  }
  const median = (a: number[]) => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

function dist2(
  data: Uint8ClampedArray,
  i: number,
  c: BgColor,
): number {
  const dr = data[i] - c.r;
  const dg = data[i + 1] - c.g;
  const db = data[i + 2] - c.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Remove the connected background and return a new ImageData with alpha=0 on
 * background pixels. Edge pixels get a soft alpha ramp to avoid jaggies.
 */
export function keyFlatBackground(
  img: ImageData,
  bg: BgColor,
  opts: { tolerance?: number; feather?: number } = {},
): ImageData {
  const { width: w, height: h, data } = img;
  const tol = opts.tolerance ?? 42;
  const feather = opts.feather ?? 18;
  const tolNear = Math.max(0, tol - feather);
  const tol2 = tol * tol;
  const tolNear2 = tolNear * tolNear;

  // Scanline flood fill from every border pixel that matches the background.
  const isBg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (isBg[p]) return;
    if (dist2(data, p * 4, bg) <= tol2) {
      isBg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  const out = new ImageData(w, h);
  out.data.set(data);
  for (let p = 0; p < w * h; p++) {
    if (!isBg[p]) continue;
    const i = p * 4;
    const d2 = dist2(data, i, bg);
    if (d2 <= tolNear2) {
      out.data[i + 3] = 0; // solidly background → fully transparent
    } else {
      // Near the tolerance edge: ramp alpha so antialiased subject edges
      // don't get a hard green/colored fringe.
      const t = (Math.sqrt(d2) - tolNear) / (tol - tolNear);
      out.data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, t)));
    }
  }
  return out;
}
