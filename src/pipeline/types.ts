/** A single decoded frame held as an ImageBitmap plus its presentation time. */
export interface Frame {
  bitmap: ImageBitmap;
  /** Presentation timestamp in microseconds (from WebCodecs). */
  timestampUs: number;
}

/** Axis-aligned crop rectangle in source-pixel coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of loop detection: the frame range that forms one clean cycle. */
export interface LoopRange {
  /** Index of the first frame of the loop. */
  startIndex: number;
  /** Index one past the last frame of the loop (exclusive). */
  endIndex: number;
  /** Estimated frames-per-second of the source animation. */
  fps: number;
  /** Mean per-pixel difference at the chosen loop seam (lower = cleaner). */
  seamError: number;
}

export interface ExportOptions {
  /** Target longest edge in px. `null` = keep native size. */
  maxEdge: number | null;
  fps: number;
  removeBackground: boolean;
  /** Hard ceiling in bytes (Slack animated emoji = 128 * 1024). */
  maxBytes: number | null;
}

export const SLACK_EMOJI_BYTES = 128 * 1024;
export const SLACK_EMOJI_EDGE = 128;
