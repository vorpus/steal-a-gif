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
): Promise<Blob> {
  let working = frames;
  let paletteColors = 256;

  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = encodeOnce(working, opts.fps, paletteColors);
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
  const bytes = encodeOnce(working, opts.fps, paletteColors);
  return new Blob([bytes], { type: "image/gif" });
}

function encodeOnce(
  frames: ImageData[],
  fps: number,
  maxColors: number,
): Uint8Array<ArrayBuffer> {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  for (const frame of frames) {
    // oneBitAlpha makes quantize reserve palette index 0 for fully-transparent
    // pixels and map alpha<128 there, so GIF's 1-bit transparency keys on our
    // actual alpha channel instead of an arbitrary opaque color.
    const palette = quantize(frame.data, maxColors, {
      format: "rgba4444",
      oneBitAlpha: true,
    });
    const index = applyPalette(frame.data, palette, "rgba4444");
    gif.writeFrame(index, frame.width, frame.height, {
      palette,
      delay,
      transparent: true,
      transparentIndex: 0,
    });
  }
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
