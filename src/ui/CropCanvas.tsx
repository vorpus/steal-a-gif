import { useEffect, useRef } from "react";
import type { Rect } from "../pipeline";

type Corner = "nw" | "ne" | "sw" | "se";
type Edge = "n" | "e" | "s" | "w";
type Handle = Corner | Edge;

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const EDGES: Edge[] = ["n", "e", "s", "w"];

type Drag =
  | { kind: "draw"; x0: number; y0: number }
  | { kind: "move"; offX: number; offY: number }
  | { kind: "resize"; handle: Handle };

/**
 * Crop selector with draggable corner/edge handles and an optional square
 * lock. Emits the rectangle in *source-pixel* coordinates so the pipeline can
 * crop the real frames regardless of display scaling.
 */
export function CropCanvas({
  bitmap,
  value,
  square,
  onCrop,
}: {
  bitmap: ImageBitmap;
  value: Rect | null;
  square: boolean;
  onCrop: (rect: Rect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const W = bitmap.width;
  const H = bitmap.height;

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = W;
    canvas.height = H;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  }, [bitmap, W, H]);

  const toSource = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H,
    };
  };

  const clamp = (b: Rect): Rect => {
    let { x, y, width, height } = b;
    width = Math.max(8, width);
    height = Math.max(8, height);
    x = Math.max(0, Math.min(x, W - width));
    y = Math.max(0, Math.min(y, H - height));
    width = Math.min(width, W - x);
    height = Math.min(height, H - y);
    return { x, y, width, height };
  };

  // Build a box from a fixed anchor corner to a moving point, square-locked
  // by extending both axes to the larger delta.
  const fromAnchor = (ax: number, ay: number, px: number, py: number): Rect => {
    let dx = px - ax;
    let dy = py - ay;
    if (square) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * side;
      dy = (dy < 0 ? -1 : 1) * side;
    }
    return {
      x: Math.min(ax, ax + dx),
      y: Math.min(ay, ay + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  };

  const resize = (handle: Handle, px: number, py: number): Rect => {
    const b = value!;
    const l = b.x;
    const t = b.y;
    const r = b.x + b.width;
    const bot = b.y + b.height;
    switch (handle) {
      case "se":
        return fromAnchor(l, t, px, py);
      case "nw":
        return fromAnchor(r, bot, px, py);
      case "ne":
        return fromAnchor(l, bot, px, py);
      case "sw":
        return fromAnchor(r, t, px, py);
      // Edge handles only appear when not square-locked.
      case "e":
        return { x: l, y: t, width: px - l, height: b.height };
      case "w":
        return { x: px, y: t, width: r - px, height: b.height };
      case "s":
        return { x: l, y: t, width: b.width, height: py - t };
      case "n":
        return { x: l, y: py, width: b.width, height: bot - py };
    }
  };

  const beginDrag = (d: Drag) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = d;
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const p = toSource(ev.clientX, ev.clientY);
      const cur = drag.current;
      if (cur.kind === "draw") {
        onCrop(clamp(fromAnchor(cur.x0, cur.y0, p.x, p.y)));
      } else if (cur.kind === "move") {
        onCrop(
          clamp({
            x: p.x - cur.offX,
            y: p.y - cur.offY,
            width: value!.width,
            height: value!.height,
          }),
        );
      } else {
        onCrop(clamp(resize(cur.handle, p.x, p.y)));
      }
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    const p = toSource(e.clientX, e.clientY);
    beginDrag({ kind: "draw", x0: p.x, y0: p.y })(e);
  };

  const pct = (n: number, total: number) => `${(n / total) * 100}%`;
  const overlay: React.CSSProperties = value
    ? {
        left: pct(value.x, W),
        top: pct(value.y, H),
        width: pct(value.width, W),
        height: pct(value.height, H),
      }
    : { display: "none" };

  const handlePos: Record<Handle, React.CSSProperties> = {
    nw: { left: 0, top: 0 },
    ne: { left: "100%", top: 0 },
    sw: { left: 0, top: "100%" },
    se: { left: "100%", top: "100%" },
    n: { left: "50%", top: 0 },
    s: { left: "50%", top: "100%" },
    e: { left: "100%", top: "50%" },
    w: { left: 0, top: "50%" },
  };
  const visibleHandles: Handle[] = square ? CORNERS : [...CORNERS, ...EDGES];

  return (
    <div className="cropwrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="cropcanvas"
        onPointerDown={onCanvasDown}
      />
      {value && (
        <div
          className="cropbox"
          style={overlay}
          onPointerDown={(e) => {
            const p = toSource(e.clientX, e.clientY);
            beginDrag({
              kind: "move",
              offX: p.x - value.x,
              offY: p.y - value.y,
            })(e);
          }}
        >
          {visibleHandles.map((h) => (
            <div
              key={h}
              className={`handle-dot ${h}`}
              style={handlePos[h]}
              onPointerDown={beginDrag({ kind: "resize", handle: h })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
