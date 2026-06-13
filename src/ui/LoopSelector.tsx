import { useEffect, useRef } from "react";
import type { Frame, Rect } from "../pipeline";

export interface LoopRange {
  start: number;
  /** Exclusive end index. */
  end: number;
}

const THUMB_H = 56;
const PREVIEW_MAX = 220;

/**
 * Manual loop picker: a strip of frame thumbnails with draggable start/end
 * handles, and a preview that plays the selected range on a loop so the user
 * can dial in exactly one clean cycle.
 */
export function LoopSelector({
  frames,
  crop,
  fps,
  value,
  onChange,
}: {
  frames: Frame[];
  crop: Rect;
  fps: number;
  value: LoopRange;
  onChange: (range: LoopRange) => void;
}) {
  const stripRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const n = frames.length;

  // --- thumbnail strip (redraw when frames or crop change) ---
  useEffect(() => {
    const canvas = stripRef.current!;
    const thumbW = Math.max(
      4,
      Math.round((THUMB_H * crop.width) / crop.height),
    );
    canvas.width = n * thumbW;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    frames.forEach((f, i) => {
      ctx.drawImage(
        f.bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        i * thumbW,
        0,
        thumbW,
        THUMB_H,
      );
    });
  }, [frames, crop, n]);

  // --- looping preview of the selected range ---
  useEffect(() => {
    const canvas = previewRef.current!;
    const scale = Math.min(1, PREVIEW_MAX / Math.max(crop.width, crop.height));
    const w = Math.max(1, Math.round(crop.width * scale));
    const h = Math.max(1, Math.round(crop.height * scale));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;

    const len = Math.max(1, value.end - value.start);
    const frameDur = 1000 / Math.max(1, fps);
    let raf = 0;
    let startT = -1;

    const tick = (t: number) => {
      if (startT < 0) startT = t;
      const k = Math.floor((t - startT) / frameDur) % len;
      const frame = frames[value.start + k];
      if (frame) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(
          frame.bitmap,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          w,
          h,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frames, crop, fps, value.start, value.end]);

  const indexFromEvent = (e: React.PointerEvent): number => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    return Math.min(n, Math.max(0, Math.round(frac * n)));
  };

  const startDrag =
    (which: "start" | "end") => (e: React.PointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as Element;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const rect = wrapRef.current!.getBoundingClientRect();
        const idx = Math.min(
          n,
          Math.max(0, Math.round(((ev.clientX - rect.left) / rect.width) * n)),
        );
        if (which === "start") {
          onChange({ start: Math.min(idx, value.end - 1), end: value.end });
        } else {
          onChange({ start: value.start, end: Math.max(idx, value.start + 1) });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  const leftPct = (value.start / n) * 100;
  const rightPct = (value.end / n) * 100;

  return (
    <div className="loopselector">
      <canvas ref={previewRef} className="looppreview" />
      <div className="scrubber">
        <div
          ref={wrapRef}
          className="strip"
          onPointerDown={(e) => {
            // Click on the strip moves the nearer handle.
            const idx = indexFromEvent(e);
            const toStart = Math.abs(idx - value.start);
            const toEnd = Math.abs(idx - value.end);
            if (toStart <= toEnd) {
              onChange({ start: Math.min(idx, value.end - 1), end: value.end });
            } else {
              onChange({
                start: value.start,
                end: Math.max(idx, value.start + 1),
              });
            }
          }}
        >
          <canvas ref={stripRef} className="stripcanvas" />
          <div className="dim" style={{ left: 0, width: `${leftPct}%` }} />
          <div
            className="dim"
            style={{ left: `${rightPct}%`, right: 0 }}
          />
          <div
            className="handle"
            style={{ left: `${leftPct}%` }}
            onPointerDown={startDrag("start")}
          />
          <div
            className="handle"
            style={{ left: `${rightPct}%` }}
            onPointerDown={startDrag("end")}
          />
        </div>
        <div className="scrubmeta">
          frames {value.start}–{value.end} ({value.end - value.start} ·{" "}
          {((value.end - value.start) / Math.max(1, fps)).toFixed(2)}s)
        </div>
      </div>
    </div>
  );
}
