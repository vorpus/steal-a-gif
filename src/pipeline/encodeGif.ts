import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { ExportOptions } from "./types";

/**
 * Encode RGBA frames into an animated GIF.
 *
 * `frames` are equal-size ImageData (already cropped/resized/matted). When a
 * `maxBytes` ceiling is set (e.g. Slack's 128KB), we re-encode with shrinking
 * dimensions / palette until we fit — GIF size is the real constraint, not the
 * AI, so this loop matters.
 */
export async function encodeGif(
  frames: ImageData[],
  opts: ExportOptions,
  /** Per-frame on-screen time in ms (preferred over a global fps). */
  delaysMs?: number[],
): Promise<Blob> {
  let working = frames;
  let paletteColors = 256;
  // Only key transparency when the background was actually removed. Otherwise
  // reserving a transparent palette index makes opaque pixels that quantize
  // onto it disappear — frames must stay fully opaque.
  const transparent = opts.removeBackground;

  // GIF delays are centiseconds; renderers clamp anything under ~2cs (20ms) to
  // a slow default, so floor each delay there to keep playback predictable.
  const delays = frames.map((_, i) =>
    Math.max(20, Math.round(delaysMs?.[i] ?? 1000 / opts.fps)),
  );

  // Don't shrink the emoji below this longest edge.
  const MIN_EDGE = 72;

  for (let attempt = 0; attempt < 12; attempt++) {
    const bytes = encodeOnce(working, delays, paletteColors, transparent);
    if (!opts.maxBytes || bytes.length <= opts.maxBytes) {
      return new Blob([bytes], { type: "image/gif" });
    }
    // Over budget: shrink RESOLUTION first and keep the colour count high — a
    // coarser palette makes per-frame compression noise cross colour buckets,
    // which flashes. Only drop colours once we're at the size floor.
    const edge = Math.max(working[0].width, working[0].height);
    if (edge > MIN_EDGE) {
      working = working.map((f) => downscale(f, 0.85));
    } else if (paletteColors > 32) {
      paletteColors = Math.floor(paletteColors / 2);
    } else {
      break;
    }
  }

  // Give back the smallest attempt even if it still exceeds the ceiling.
  const bytes = encodeOnce(working, delays, paletteColors, transparent);
  return new Blob([bytes], { type: "image/gif" });
}

function encodeOnce(
  frames: ImageData[],
  delays: number[],
  maxColors: number,
  transparent: boolean,
): Uint8Array<ArrayBuffer> {
  const gif = GIFEncoder();
  const format = transparent ? "rgba4444" : "rgb565";

  // ONE palette for the whole animation. Quantizing each frame independently
  // gives every frame a slightly different palette, so a constant colour lands
  // on different entries frame-to-frame and the image shimmers/flashes. A
  // single shared palette keeps colours stable across the loop. We build it
  // from an evenly-spaced sample of frames so the colour range is covered
  // without concatenating every pixel of every frame.
  const palette = quantize(samplePixels(frames), maxColors, {
    format,
    oneBitAlpha: transparent,
  });

  frames.forEach((frame, i) => {
    const delay = delays[i];
    const index = applyPalette(frame.data, palette, format);
    gif.writeFrame(
      index,
      frame.width,
      frame.height,
      transparent
        ? { palette, delay, transparent: true, transparentIndex: 0 }
        : { palette, delay },
    );
  });
  gif.finish();
  // Copy into a plain ArrayBuffer-backed view so it's a valid BlobPart.
  const src = gif.bytes();
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  return bytes;
}

/**
 * Concatenate the pixels of an evenly-spaced sample of frames into one RGBA
 * buffer for global palette quantization. Sampling (rather than every frame)
 * bounds memory while still covering the loop's full colour range.
 */
function samplePixels(frames: ImageData[]): Uint8ClampedArray {
  const MAX = 16;
  const count = Math.min(frames.length, MAX);
  const picks: ImageData[] = [];
  for (let i = 0; i < count; i++) {
    picks.push(frames[Math.floor((i * frames.length) / count)]);
  }
  const total = picks.reduce((n, f) => n + f.data.length, 0);
  const out = new Uint8ClampedArray(total);
  let off = 0;
  for (const f of picks) {
    out.set(f.data, off);
    off += f.data.length;
  }
  return out;
}

function downscale(frame: ImageData, factor: number): ImageData {
  const w = Math.max(1, Math.round(frame.width * factor));
  const h = Math.max(1, Math.round(frame.height * factor));
  const src = new OffscreenCanvas(frame.width, frame.height);
  src.getContext("2d")!.putImageData(frame, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const dctx = dst.getContext("2d")!;
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(src, 0, 0, w, h);
  return dctx.getImageData(0, 0, w, h);
}
