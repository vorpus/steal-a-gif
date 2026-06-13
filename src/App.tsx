import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareFrames,
  renderGifs,
  SLACK_EMOJI_BYTES,
  SLACK_EMOJI_EDGE,
  type Prepared,
  type Rect,
  type Stage,
} from "./pipeline";
import { CropCanvas } from "./ui/CropCanvas";
import { LoopSelector, type LoopRange } from "./ui/LoopSelector";

interface Output {
  label: string;
  url: string;
  bytes: number;
}

export function App() {
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [range, setRange] = useState<LoopRange | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [autoTighten, setAutoTighten] = useState(false);
  const [square, setSquare] = useState(true);
  const [stage, setStage] = useState<Stage | null>(null);
  const [stageDetail, setStageDetail] = useState("");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const outputsRef = useRef<Output[]>([]);
  const rendering = stage !== null && stage !== "done";

  useEffect(
    () => () => outputsRef.current.forEach((o) => URL.revokeObjectURL(o.url)),
    [],
  );

  const onFile = useCallback(async (f: File) => {
    outputsRef.current.forEach((o) => URL.revokeObjectURL(o.url));
    outputsRef.current = [];
    setOutputs([]);
    setError(null);
    setPrep(null);
    setCrop(null);
    setRange(null);
    setPreparing(true);
    try {
      const prepared = await prepareFrames(f);
      setPrep(prepared);
      setRange(prepared.suggested);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  }, []);

  // Drag-and-drop a file anywhere on the window.
  useEffect(() => {
    let depth = 0;
    const isFile = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFile(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (isFile(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!isFile(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFile]);

  const effectiveCrop: Rect | null = prep
    ? crop ?? { x: 0, y: 0, width: prep.width, height: prep.height }
    : null;

  const run = useCallback(async () => {
    if (!prep || !effectiveCrop || !range) return;
    setError(null);
    setOutputs([]);
    try {
      const res = await renderGifs(
        prep,
        range,
        effectiveCrop,
        {
          removeBackground: removeBg,
          autoTighten,
          sizes: [
            { label: "original", maxEdge: null, maxBytes: null },
            {
              label: "slack",
              maxEdge: SLACK_EMOJI_EDGE,
              maxBytes: SLACK_EMOJI_BYTES,
            },
          ],
        },
        (s, d) => {
          setStage(s);
          setStageDetail(d ?? "");
        },
      );
      const labels: Record<string, string> = {
        original: `Original · ${res.finalCrop.width}×${res.finalCrop.height} · ${res.frameCount}f`,
        slack: "Slack · 128px",
      };
      const next: Output[] = res.outputs.map((o) => ({
        label: labels[o.label] ?? o.label,
        url: URL.createObjectURL(o.gif),
        bytes: o.bytes,
      }));
      outputsRef.current = next;
      setOutputs(next);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage(null);
    }
  }, [prep, effectiveCrop, range, removeBg, autoTighten]);

  const orientation =
    prep && prep.height > prep.width ? "vertical" : "horizontal";

  return (
    <main className="app">
      {dragging && (
        <div className="scrim">
          <div className="scrim-msg">Drop anywhere to upload</div>
        </div>
      )}

      <header className="topbar">
        <h1>steal-a-gif</h1>
        <label className="filepick-sm">
          <input
            type="file"
            accept="video/*,image/gif"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          {preparing ? "Decoding…" : prep ? "Change clip" : "Upload"}
        </label>
      </header>

      {!prep && (
        <div className="empty">
          {preparing ? (
            <p>Decoding…</p>
          ) : error ? (
            <p className="error">⚠ {error}</p>
          ) : (
            <p>
              Drag a screen recording anywhere on the page,
              <br />
              or click <strong>Upload</strong>.
            </p>
          )}
        </div>
      )}

      {prep && prep.compat === "fallback" && (
        <div className="banner">
          ⚠ Your browser can't hardware-decode this file, so the export uses a
          slower path and may take a few seconds. If it fails, try Chrome or
          Safari.
        </div>
      )}

      {prep && effectiveCrop && range && (
        <div className={`workspace ${orientation}`}>
          <div className="stage">
            <div className="stage-toolbar">
              <label className="inlinecheck">
                <input
                  type="checkbox"
                  checked={square}
                  onChange={(e) => {
                    setSquare(e.target.checked);
                    if (e.target.checked && crop) {
                      const side = Math.min(crop.width, crop.height);
                      setCrop({
                        x: crop.x + (crop.width - side) / 2,
                        y: crop.y + (crop.height - side) / 2,
                        width: side,
                        height: side,
                      });
                    }
                  }}
                />
                Lock to square
              </label>
              {crop && (
                <button className="link" onClick={() => setCrop(null)}>
                  Clear box
                </button>
              )}
            </div>
            <div className="stage-canvas">
              <CropCanvas
                bitmap={prep.frames[0].bitmap}
                value={crop}
                square={square}
                onCrop={setCrop}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-block">
              <h2>Trim to one loop</h2>
              <LoopSelector
                frames={prep.frames}
                crop={effectiveCrop}
                fps={prep.fps}
                value={range}
                onChange={setRange}
              />
            </div>

            <div className="panel-block controls">
              <label className="inlinecheck">
                <input
                  type="checkbox"
                  checked={removeBg}
                  onChange={(e) => setRemoveBg(e.target.checked)}
                />
                Remove app background
              </label>
              <label className="inlinecheck">
                <input
                  type="checkbox"
                  checked={autoTighten}
                  onChange={(e) => setAutoTighten(e.target.checked)}
                />
                Auto-tighten crop
              </label>
              <button onClick={run} disabled={rendering}>
                {rendering ? "Working…" : "Make GIF"}
              </button>
              {rendering && (
                <span className="status">
                  <span className="spinner" aria-hidden /> {stage} {stageDetail}
                </span>
              )}
              {error && <span className="error">⚠ {error}</span>}
            </div>

            {outputs.length > 0 && (
              <div className="panel-block results">
                {outputs.map((o) => (
                  <figure key={o.label}>
                    <img src={o.url} alt={o.label} />
                    <figcaption>
                      {o.label} · {(o.bytes / 1024).toFixed(0)}KB
                      <a
                        href={o.url}
                        download={`steal-a-gif-${slug(o.label)}.gif`}
                      >
                        Download
                      </a>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
