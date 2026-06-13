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
  const [square, setSquare] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [stageDetail, setStageDetail] = useState("");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<string | null>(null);
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
      setCrop({ x: 0, y: 0, width: prepared.width, height: prepared.height });
      setRange(prepared.suggested);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  }, []);

  const run = useCallback(async () => {
    if (!prep || !crop || !range) return;
    setError(null);
    setOutputs([]);
    try {
      const res = await renderGifs(
        prep.frames,
        range,
        crop,
        {
          removeBackground: removeBg,
          autoTighten,
          fps: prep.fps,
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
        original: `Original (${res.finalCrop.width}×${res.finalCrop.height}, ${res.frameCount} frames)`,
        slack: "Slack emoji (128px)",
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
  }, [prep, crop, range, removeBg, autoTighten]);

  return (
    <main className="app">
      <header>
        <h1>steal-a-gif</h1>
        <p className="tagline">
          Screen-record a GIF that won't let you save it, drop the clip here,
          and get a clean GIF back.
        </p>
      </header>

      <section className="step">
        <label className="filepick">
          <input
            type="file"
            accept="video/*,image/gif"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          {preparing ? "Decoding…" : prep ? "Choose a different clip" : "Choose a screen recording…"}
        </label>
      </section>

      {prep && crop && (
        <section className="step">
          <h2>1 · Box the animation</h2>
          <label className="inlinecheck">
            <input
              type="checkbox"
              checked={square}
              onChange={(e) => {
                setSquare(e.target.checked);
                // Snap the current box to a centered square on enable.
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
          <CropCanvas
            bitmap={prep.frames[0].bitmap}
            value={crop}
            square={square}
            onCrop={setCrop}
          />
        </section>
      )}

      {prep && crop && range && (
        <section className="step">
          <h2>2 · Trim to one loop</h2>
          <p className="hint">
            Drag the handles so the preview plays one clean cycle with no jump.
          </p>
          <LoopSelector
            frames={prep.frames}
            crop={crop}
            fps={prep.fps}
            value={range}
            onChange={setRange}
          />
        </section>
      )}

      {prep && (
        <section className="step controls">
          <label>
            <input
              type="checkbox"
              checked={removeBg}
              onChange={(e) => setRemoveBg(e.target.checked)}
            />
            Remove app background
          </label>
          <label>
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
        </section>
      )}

      {rendering && (
        <section className="step status">
          <span className="spinner" aria-hidden /> {stage} {stageDetail}
        </section>
      )}

      {error && <section className="step error">⚠ {error}</section>}

      {outputs.length > 0 && (
        <section className="step results">
          {outputs.map((o) => (
            <figure key={o.label}>
              <img src={o.url} alt={o.label} />
              <figcaption>
                {o.label} — {(o.bytes / 1024).toFixed(0)} KB
                <a href={o.url} download={`steal-a-gif-${slug(o.label)}.gif`}>
                  Download
                </a>
              </figcaption>
            </figure>
          ))}
        </section>
      )}
    </main>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
