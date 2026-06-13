import { useEffect, useRef, useState } from "react";
import type { Rect } from "../pipeline";

/**
 * Shows a still frame of the recording and lets the user drag a selection box.
 * Emits the rectangle in *source-pixel* coordinates so the pipeline can crop
 * the real frames regardless of display scaling.
 */
export function CropCanvas({
  bitmap,
  value,
  onCrop,
}: {
  bitmap: ImageBitmap;
  value: Rect | null;
  onCrop: (rect: Rect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x0: number; y0: number } | null>(null);
  const [box, setBox] = useState<Rect | null>(value);

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  useEffect(() => setBox(value), [value]);

  const toSource = (e: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toSource(e);
    drag.current = { x0: p.x, y0: p.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = toSource(e);
    setBox({
      x: Math.min(drag.current.x0, p.x),
      y: Math.min(drag.current.y0, p.y),
      width: Math.abs(p.x - drag.current.x0),
      height: Math.abs(p.y - drag.current.y0),
    });
  };
  const onUp = () => {
    drag.current = null;
    if (box && box.width > 4 && box.height > 4) onCrop(box);
  };

  const overlay: React.CSSProperties = box
    ? {
        left: `${(box.x / bitmap.width) * 100}%`,
        top: `${(box.y / bitmap.height) * 100}%`,
        width: `${(box.width / bitmap.width) * 100}%`,
        height: `${(box.height / bitmap.height) * 100}%`,
      }
    : { display: "none" };

  return (
    <div className="cropwrap">
      <canvas
        ref={canvasRef}
        className="cropcanvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      />
      <div className="cropbox" style={overlay} />
    </div>
  );
}
