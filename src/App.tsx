import { useCallback, useRef, useState } from "react";
import {
  extractGifs,
  SLACK_EMOJI_BYTES,
  SLACK_EMOJI_EDGE,
  type Rect,
  type Stage,
} from "./pipeline";
import { CropCanvas } from "./ui/CropCanvas";

interface Output {
  label: string;
  url: string;
  bytes: number;
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [stageDetail, setStageDetail] = useState<string>("");
  const [removeBg, setRemoveBg] = useState(true);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null && stage !== "done";
  const outputsRef = useRef<Output[]>([]);

  const onFile = useCallback((f: File) => {
    outputsRef.current.forEach((o) => URL.revokeObjectURL(o.url));
    outputsRef.current = [];
    setOutputs([]);
    setError(null);
    setCrop(null);
    setFile(f);
  }, []);

  const run = useCallback(async () => {
    if (!file || !crop) return;
    setError(null);
    setOutputs([]);
    try {
      // Decode once; derive both sizes from the same loop + crop + matte.
      const res = await extractGifs(
        file,
        crop,
        {
          removeBackground: removeBg,
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
  }, [file, crop, removeBg]);

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
          {file ? file.name : "Choose a screen recording…"}
        </label>
      </section>

      {file && (
        <section className="step">
          <h2>Drag a box around the animation</h2>
          <CropCanvas file={file} onCrop={setCrop} />
        </section>
      )}

      {crop && (
        <section className="step controls">
          <label>
            <input
              type="checkbox"
              checked={removeBg}
              onChange={(e) => setRemoveBg(e.target.checked)}
            />
            Remove app background
          </label>
          <button onClick={run} disabled={busy}>
            {busy ? "Working…" : "Make GIF"}
          </button>
        </section>
      )}

      {busy && (
        <section className="step status">
          <Spinner /> {stage} {stageDetail}
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

function Spinner() {
  return <span className="spinner" aria-hidden />;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
