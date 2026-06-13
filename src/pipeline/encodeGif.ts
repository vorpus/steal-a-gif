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

  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = encodeOnce(working, delays, paletteColors, transparent);
    if (!opts.maxBytes || bytes.length <= opts.maxBytes) {
      return new Blob([bytes], { type: "image/gif" });
    }
    // Over budget: first squeeze the palette, then start dropping resolution.
    if (paletteColors > 64) {
      paletteColors = Math.floor(paletteColors / 2);
    } else {
      working = working.map((f) => downscale(f, 0.85));
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
  frames.forEach((frame, i) => {
    const delay = delays[i];
    // With transparency, oneBitAlpha reserves palette index 0 for fully-
    // transparent pixels so GIF 1-bit transparency keys on our alpha channel.
    // Without it, encode opaque in rgb565 for better color and no stray holes.
    const format = transparent ? "rgba4444" : "rgb565";
    const palette = quantize(frame.data, maxColors, {
      format,
      oneBitAlpha: transparent,
    });
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
