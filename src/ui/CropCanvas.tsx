import { useEffect, useRef, useState } from "react";
import type { Rect } from "../pipeline";

/**
 * Shows the first frame of the recording and lets the user drag a rough
 * selection box. Emits the rectangle in *source-pixel* coordinates so the
 * pipeline can crop the real frames regardless of display scaling.
 */
export function CropCanvas({
  file,
  onCrop,
}: {
  file: File;
  onCrop: (rect: Rect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x0: number; y0: number } | null>(null);
  const [box, setBox] = useState<Rect | null>(null);

  // Paint the first decoded frame onto the canvas.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    const grab = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      setDims({ w: video.videoWidth, h: video.videoHeight });
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      URL.revokeObjectURL(url);
    };
    video.onloadeddata = () => {
      video.currentTime = 0.05;
    };
    video.onseeked = grab;
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
    const r: Rect = {
      x: Math.min(drag.current.x0, p.x),
      y: Math.min(drag.current.y0, p.y),
      width: Math.abs(p.x - drag.current.x0),
      height: Math.abs(p.y - drag.current.y0),
    };
    setBox(r);
  };
  const onUp = () => {
    drag.current = null;
    if (box && box.width > 4 && box.height > 4) onCrop(box);
  };

  const overlay: React.CSSProperties =
    box && dims
      ? {
          left: `${(box.x / dims.w) * 100}%`,
          top: `${(box.y / dims.h) * 100}%`,
          width: `${(box.width / dims.w) * 100}%`,
          height: `${(box.height / dims.h) * 100}%`,
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
