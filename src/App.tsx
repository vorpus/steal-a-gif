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

type Step = "box" | "trim" | "export";

// buttons.github.io exposes this global once buttons.js has loaded.
declare global {
  interface Window {
    GitHubButton?: { render: (callback?: () => void) => void };
  }
}

const GH_BUTTONS_SRC = "https://buttons.github.io/buttons.js";

interface Output {
  key: "original" | "slack";
  title: string;
  caption: string;
  url: string;
  filename: string;
  slack?: boolean;
}

// BASE_URL is "/" in dev and "/steal-a-gif/" in the GitHub Pages build, so
// these resolve correctly in both. The videos are served from the same Pages
// origin (no CORS).
const BASE = import.meta.env.BASE_URL;
const asset = (p: string) => `${BASE}${p}`;

const SAMPLES = [
  {
    src: "TikTok",
    url: asset("samples/tiktok-catfight.MP4"),
    thumb: asset("samples/tiktok-catfight.thumb.png"),
  },
  {
    src: "XHS",
    url: asset("samples/xhs-smelly.MP4"),
    thumb: asset("samples/xhs-smelly.thumb.png"),
  },
  {
    src: "YouTube",
    url: asset("samples/yt-snoop.MP4"),
    thumb: asset("samples/yt-snoop.thumb.png"),
  },
];

const LOAD_MSGS = [
  "reading frames…",
  "detecting orientation…",
  "checking codec support…",
  "building the editor…",
];

function useIsDesktop() {
  const [desktop, setDesktop] = useState(
    () => window.matchMedia("(min-width: 760px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 760px)");
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

// buttons.js scans the DOM for `.github-button` anchors exactly once, when it
// first loads. React mounts the star anchor after that scan (and again when we
// navigate back to the landing view), so the anchor would otherwise be left as
// plain text. This hook calls GitHubButton.render() to force a rescan on every
// mount — loading the script first (and polling for the global) if needed.
function useGithubButtonRender() {
  useEffect(() => {
    let interval: number | undefined;

    if (window.GitHubButton?.render) {
      // Script already loaded — just rescan the freshly mounted anchor.
      window.GitHubButton.render();
    } else {
      if (!document.querySelector(`script[src="${GH_BUTTONS_SRC}"]`)) {
        const s = document.createElement("script");
        s.src = GH_BUTTONS_SRC;
        s.async = true;
        document.body.appendChild(s);
      }
      interval = window.setInterval(() => {
        if (window.GitHubButton?.render) {
          window.clearInterval(interval);
          window.GitHubButton.render();
        }
      }, 80);
    }

    return () => {
      if (interval) window.clearInterval(interval);
    };
  }, []);
}

function scaleToEdge(r: Rect, edge: number) {
  const s = Math.min(1, edge / Math.max(r.width, r.height));
  return { w: Math.round(r.width * s), h: Math.round(r.height * s) };
}
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function App() {
  const isDesktop = useIsDesktop();
  useGithubButtonRender();

  const [prep, setPrep] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [loadMsg, setLoadMsg] = useState(LOAD_MSGS[0]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [step, setStep] = useState<Step>("box");

  const [crop, setCrop] = useState<Rect | null>(null);
  const [range, setRange] = useState<LoopRange | null>(null);
  const [square, setSquare] = useState(true);
  const [removeBg, setRemoveBg] = useState(true);
  const [autoTighten, setAutoTighten] = useState(false);

  const [stage, setStage] = useState<Stage | null>(null);
  const [stageDetail, setStageDetail] = useState("");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [hevcOpen, setHevcOpen] = useState(false);
  const [hevcDismissed, setHevcDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  // If a breadcrumb is still set on load, the tab was killed (out of memory) and
  // reloaded mid-decode or mid-render — the only OOM signal we get on iOS.
  const [crashWarn, setCrashWarn] = useState<{
    phase: "decode" | "render";
    frames?: number;
  } | null>(null);

  // landing chat intro
  const [introActive, setIntroActive] = useState(true);
  // Start the typing tease on first paint so it rides in with the staggered
  // intro messages — it reads as the other side already typing on page load.
  const [introTyping, setIntroTyping] = useState(true);
  const [introFinal, setIntroFinal] = useState(false);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [sent, setSent] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const outputsRef = useRef<Output[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Holds the current clip's preview frames so we can close their ImageBitmaps
  // (native memory) when a new clip is loaded, instead of waiting for GC.
  const framesRef = useRef<{ bitmap: ImageBitmap }[] | null>(null);
  const rendering = stage !== null && stage !== "done";

  useEffect(() => {
    // After the tease, swap the typing dots for the closing "drop a clip below"
    // message. Keep the original 2100ms delay so the timing is unchanged.
    const b = setTimeout(() => {
      setIntroTyping(false);
      setIntroFinal(true);
    }, 2100);
    const c = setTimeout(() => setIntroActive(false), 1700);
    return () => {
      clearTimeout(b);
      clearTimeout(c);
    };
  }, []);

  useEffect(
    () => () => {
      outputsRef.current.forEach((o) => URL.revokeObjectURL(o.url));
      framesRef.current?.forEach((f) => f.bitmap.close());
    },
    [],
  );

  // Detect an out-of-memory tab reload: a breadcrumb still set on load means the
  // last decode or render crashed the tab before it could clear it. We only
  // READ here (clearing happens on dismiss / next run) so React StrictMode's
  // double-invoked effect can't consume it before the live mount sees it.
  useEffect(() => {
    try {
      const b = localStorage.getItem("sag:busy");
      if (b) setCrashWarn(JSON.parse(b));
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Keep the newest messages in view when content is appended to the thread
  // (examples reveal, result send, intro completing). .thread has CSS
  // scroll-behavior:smooth, so assigning scrollTop animates. We fire on the
  // next frame and again after the fly-in/image settles.
  const scrollToBottom = useCallback(() => {
    // scrollHeight includes the thread's bottom padding (which clears the
    // composer overlay), so this lands the last message ABOVE the overlay —
    // unlike scrollIntoView on the sentinel, which stops above that padding.
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    // One instant scroll on the next frame (result GIF also re-scrolls onLoad).
    // Instant + single-shot so it can't fight a user scroll moments later.
    const r = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(r);
  }, [samplesOpen, sent, introFinal, scrollToBottom]);

  // cycle the loading copy while decoding
  useEffect(() => {
    if (!preparing) return;
    let i = 0;
    setLoadMsg(LOAD_MSGS[0]);
    const iv = setInterval(() => {
      i = Math.min(i + 1, LOAD_MSGS.length - 1);
      setLoadMsg(LOAD_MSGS[i]);
    }, 360);
    return () => clearInterval(iv);
  }, [preparing]);

  const onFile = useCallback(async (file: File) => {
    outputsRef.current.forEach((o) => URL.revokeObjectURL(o.url));
    outputsRef.current = [];
    // Free the previous clip's preview-frame bitmaps before decoding the next.
    framesRef.current?.forEach((f) => f.bitmap.close());
    framesRef.current = null;
    setOutputs([]);
    setError(null);
    setPrep(null);
    setCrop(null);
    setRange(null);
    setSent(false);
    setHevcOpen(false);
    setHevcDismissed(false);
    setCrashWarn(null);
    setPreparing(true);
    // Breadcrumb: if the tab dies of OOM while decoding ("building your
    // editor"), this survives the reload so we can flag it on next load.
    try {
      localStorage.setItem("sag:busy", JSON.stringify({ phase: "decode" }));
    } catch {
      /* storage unavailable */
    }
    try {
      const prepared = await prepareFrames(file);
      framesRef.current = prepared.frames;
      setPrep(prepared);
      // Default the trim to a 10-frame window starting ~5% into the clip.
      const n = prepared.frames.length;
      const start = Math.min(Math.round(n * 0.05), Math.max(0, n - 10));
      setRange({ start, end: Math.min(n, start + 10) });
      setStep("box");
      setEditorOpen(true);
      if (prepared.compat !== "webcodecs") setHevcOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
      try {
        localStorage.removeItem("sag:busy");
      } catch {
        /* storage unavailable */
      }
    }
  }, []);

  const loadSample = useCallback(
    async (url: string) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("missing");
        const blob = await res.blob();
        const name = url.split("/").pop() || "sample.mp4";
        await onFile(new File([blob], name, { type: blob.type || "video/mp4" }));
      } catch {
        // No bundled sample yet — let the user pick their own clip.
        fileRef.current?.click();
      }
    },
    [onFile],
  );

  // drag-and-drop anywhere
  useEffect(() => {
    let depth = 0;
    const isFile = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFile(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (isFile(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isFile(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [onFile]);

  const makeGif = useCallback(async () => {
    // A box is mandatory now — no full-frame fallback (keeps decode memory low).
    if (!prep || !crop || !range) return;
    setError(null);
    setOutputs([]);
    setCrashWarn(null);
    // Breadcrumb: if the tab dies of OOM mid-render, this survives the reload
    // and we detect it on next load (no other signal exists, esp. on iOS).
    try {
      localStorage.setItem(
        "sag:busy",
        JSON.stringify({ phase: "render", frames: range.end - range.start }),
      );
    } catch {
      /* storage unavailable */
    }
    try {
      const res = await renderGifs(
        prep,
        range,
        crop,
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
      const fc = {
        x: res.finalCrop.x,
        y: res.finalCrop.y,
        width: Math.round(res.finalCrop.width),
        height: Math.round(res.finalCrop.height),
      };
      const slackDim = scaleToEdge(fc, SLACK_EMOJI_EDGE);
      const next: Output[] = res.outputs.map((o) => {
        if (o.label === "slack") {
          return {
            key: "slack",
            title: "Slack emoji",
            caption: `${slackDim.w} × ${slackDim.h} · sized to fit · ${kb(o.bytes)}`,
            url: URL.createObjectURL(o.gif),
            filename: "steal-a-gif-slack.gif",
            slack: true,
          };
        }
        return {
          key: "original",
          title: "Full size",
          caption: `${fc.width} × ${fc.height} · ${res.frameCount}f · ${kb(o.bytes)}`,
          url: URL.createObjectURL(o.gif),
          filename: "steal-a-gif-full-size.gif",
        };
      });
      outputsRef.current = next;
      setOutputs(next);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage(null);
    } finally {
      // Render finished (success or error) without crashing — clear breadcrumb.
      try {
        localStorage.removeItem("sag:busy");
      } catch {
        /* storage unavailable */
      }
    }
  }, [prep, crop, range, removeBg, autoTighten]);

  const sendToChat = useCallback(() => {
    setEditorOpen(false);
    setSent(true);
    // Scroll handled by the thread-bottom effect on `sent`.
  }, []);

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const slackOut = outputs.find((o) => o.slack);

  // ---- shared editor pieces ----
  const squareToggle = (
    <Toggle
      on={square}
      title="Lock to square"
      sub="best for Slack & emoji slots"
      onClick={() => {
        const nextOn = !square;
        setSquare(nextOn);
        if (nextOn && crop) {
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
  );

  const cropArea = prep && (
    <div className="recwrap">
      <CropCanvas
        bitmap={prep.frames[0].bitmap}
        value={crop}
        square={square}
        onCrop={setCrop}
      />
    </div>
  );

  const trimArea = prep && crop && range && (
    <>
      <LoopSelector
        frames={prep.frames}
        crop={crop}
        fps={prep.fps}
        value={range}
        onChange={setRange}
      />
      <div className="qnote">
        <span className="s">✦</span>
        <span>
          This preview is low-res to stay snappy.{" "}
          <b>The export re-decodes the real frames at full quality &amp; frame rate.</b>
        </span>
      </div>
    </>
  );

  const optionToggles = (
    <>
      <Toggle
        on={removeBg}
        title="Remove app background"
        sub="remove solid color background"
        onClick={() => setRemoveBg((v) => !v)}
      />
      <Toggle
        on={autoTighten}
        title="Auto-tighten crop"
        sub="trim empty edges automatically"
        onClick={() => setAutoTighten((v) => !v)}
      />
    </>
  );

  const statusBlock = (
    <>
      {rendering && (
        <div className="statusline">
          <span className="spinner" /> {stage} {stageDetail}
        </div>
      )}
      {error && <div className="errline">⚠ {error}</div>}
    </>
  );

  const outputCards = (withSend: boolean) =>
    outputs.length > 0 && (
      <>
        {outputs.map((o) => (
          <div className="outcard" key={o.key}>
            <img className="th checker dark" src={o.url} alt={o.title} />
            <div className="meta2">
              <div className="otitle">
                {o.title}
                {o.slack && <span className="badge">≤128KB</span>}
              </div>
              <div className="ocap">{o.caption}</div>
              <a className="dlbtn" href={o.url} download={o.filename}>
                ↓ Download
              </a>
            </div>
          </div>
        ))}
        {withSend && (
          <button className="primary" onClick={sendToChat}>
            back to chat ›
          </button>
        )}
      </>
    );

  return (
    <main className="app">
      <input
        ref={fileRef}
        className="filein"
        type="file"
        accept="video/*,image/gif"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset so picking the SAME file again still fires onChange.
          e.target.value = "";
          if (f) onFile(f);
        }}
      />

      {dragging && (
        <div className="scrim">
          <div className="scrim-msg">Drop your recording anywhere</div>
        </div>
      )}

      {crashWarn && (
        <div className="modal">
          <div className="card">
            <div className="ico">⚠</div>
            <h3>That clip was too big for this device</h3>
            {crashWarn.phase === "render" ? (
              <p>
                Your last export ({crashWarn.frames} frames) ran out of memory
                and reloaded the page. Try a <b>tighter box</b> or a{" "}
                <b>shorter loop</b>.
              </p>
            ) : (
              <p>
                Loading your last clip ran out of memory and reloaded the page.
                Try a <b>shorter</b> or <b>lower-resolution</b> recording.
              </p>
            )}
            <button
              className="primary"
              style={{ marginTop: 0 }}
              onClick={() => {
                setCrashWarn(null);
                try {
                  localStorage.removeItem("sag:busy");
                } catch {
                  /* storage unavailable */
                }
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ===================== LANDING (chat) ===================== */}
      <div className="landing">
        <div className="chead">
          <div className="av">🫳</div>
          <div>
            <div className="who">steal-a-gif</div>
            <div className="stat">no receipts · grab &amp; go</div>
          </div>
          <div className="ghstar">
            <a
              className="github-button"
              href="https://github.com/vorpus/steal-a-gif"
              data-icon="octicon-star"
              data-show-count="true"
              aria-label="Star vorpus/steal-a-gif on GitHub"
            >
              Star
            </a>
          </div>
        </div>

        <div className="thread" ref={threadRef}>
         <div className={`thread-inner ${introActive ? "intro" : ""}`}>
          <div className="time">TODAY</div>
          <div className="row">
            <div className="av-s">🫳</div>
            <div className="bub">Saw a sticker you wanted to keep? 👀</div>
          </div>
          <div className="row">
            <div className="av-s">🫳</div>
            <div className="bub">
              Upload a screen recording and I'll pull the animation out - like
              this:
              <div className="ba">
                <div className="tile raw">
                  <img
                    className="tileimg"
                    src={asset("samples/xhs-smelly.before.png")}
                    alt="raw sticker"
                  />
                </div>
                <span className="arrow">→</span>
                <div className="tile checker">
                  <img
                    className="tileimg after"
                    src={asset("samples/example-export.gif")}
                    alt="clean sticker"
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="row out">
            <div className="bub">wait it removes the background too?</div>
          </div>
          <div className="row">
            <div className="av-s">🫳</div>
            <div className="bub">
              Yep. Background gone, edges clean. Works on iMessage, TikTok,
              XHS, wherever - paste it into any chat ✨
            </div>
          </div>

          {introTyping && (
            <div className="row">
              <div className="av-s">🫳</div>
              <div className="typing">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
          {introFinal && (
            <>
              <div className="row introup">
                <div className="av-s">🫳</div>
                <div className="bub">Go on then - drop a clip below 👇</div>
              </div>
              {!samplesOpen && (
                <div className="row out introup">
                  <button className="ghost" onClick={() => setSamplesOpen(true)}>
                    Got an example recording I can use?
                  </button>
                </div>
              )}
            </>
          )}
          {samplesOpen && (
            <div className="samples play">
              <div className="row out">
                <div className="bub">Got an example recording I can use?</div>
              </div>
              <div className="row">
                <div className="av-s">🫳</div>
                <div className="bub">
                  On it 🫡 pick one:
                  <div className="samrow">
                    {SAMPLES.map((s) => (
                      <button
                        key={s.src}
                        className="sample"
                        onClick={() => loadSample(s.url)}
                      >
                        <img className="samthumb" src={s.thumb} alt={s.src} />
                        <span className="src">{s.src}</span>
                        <span className="play">▶</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {sent && slackOut && (
            <div className="result play">
              <div className="row out">
                <div className="sticker-out">
                  <img
                    className="box checker"
                    src={slackOut.url}
                    alt="result"
                    onLoad={scrollToBottom}
                  />
                </div>
              </div>
              <div className="row">
                <div className="av-s">🫳</div>
                <div className="bub">
                  Clean ✨ Download it below 👇
                  <div className="samrow" style={{ marginTop: 10 }}>
                    {outputs.map((o) => (
                      <a
                        key={o.key}
                        className="dlbtn"
                        href={o.url}
                        download={o.filename}
                      >
                        ↓ {o.title}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
         </div>
        </div>

        <div className="composer">
          <div className="inner">
            <div className="dropbar" onClick={() => fileRef.current?.click()}>
              <div className="plus">＋</div>
              <div className="ph">
                {isDesktop
                  ? "Drop a screen recording, or click to choose…"
                  : "Add a screen recording…"}
              </div>
              <button className="send" aria-label="choose file">
                ▸
              </button>
            </div>
            <div className="micro">runs in your browser · nothing uploaded</div>
          </div>
        </div>
      </div>

      {/* ===================== LOADING ===================== */}
      {preparing && (
        <div className="loading">
          <div className="dots3">
            <i />
            <i />
            <i />
          </div>
          <div className="l1">Decoding your clip…</div>
          <div className="l2">{loadMsg}</div>
        </div>
      )}

      {/* ===================== EDITOR ===================== */}
      <div className={`editor ${editorOpen ? "show" : ""}`}>
        {isDesktop ? (
          <DesktopEditor
            squareToggle={squareToggle}
            cropArea={cropArea}
            crop={crop}
            onClearBox={() => setCrop(null)}
            trimArea={trimArea}
            optionToggles={optionToggles}
            statusBlock={statusBlock}
            rendering={rendering}
            hasOutputs={outputs.length > 0}
            onMakeGif={makeGif}
            outputCards={outputCards}
            onClose={closeEditor}
          />
        ) : (
          <MobileEditor
            step={step}
            setStep={setStep}
            onClose={closeEditor}
            hasCrop={!!crop}
            squareToggle={squareToggle}
            cropArea={cropArea}
            trimArea={trimArea}
            optionToggles={optionToggles}
            statusBlock={statusBlock}
            rendering={rendering}
            hasOutputs={outputs.length > 0}
            onMakeGif={makeGif}
            outputCards={outputCards}
          />
        )}
      </div>

      {/* ===================== HEVC popup ===================== */}
      {editorOpen && hevcOpen && !hevcDismissed && prep && (
        <div className="modal">
          <div className="card">
            <div className="ico">⚠</div>
            <h3>This browser can't fully decode the clip</h3>
            <p>
              It looks like <b>HEVC</b>. Export will fall back to the
              lower-frame-rate preview capture. For every frame at full quality,
              open steal-a-gif in <b>Chrome</b> or <b>Safari</b>.
            </p>
            <button
              className="primary"
              style={{ marginTop: 0 }}
              onClick={() => {
                setHevcOpen(false);
                setHevcDismissed(true);
              }}
            >
              Continue anyway
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function Toggle({
  on,
  title,
  sub,
  onClick,
}: {
  on: boolean;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <div className={`toggle ${on ? "on" : ""}`} onClick={onClick}>
      <div className="sw" />
      <div>
        <div className="tl">{title}</div>
        <div className="ts">{sub}</div>
      </div>
    </div>
  );
}

function MobileEditor(props: {
  step: Step;
  setStep: (s: Step) => void;
  onClose: () => void;
  hasCrop: boolean;
  squareToggle: React.ReactNode;
  cropArea: React.ReactNode;
  trimArea: React.ReactNode;
  optionToggles: React.ReactNode;
  statusBlock: React.ReactNode;
  rendering: boolean;
  hasOutputs: boolean;
  onMakeGif: () => void;
  outputCards: (withSend: boolean) => React.ReactNode;
}) {
  const titles: Record<Step, string> = {
    box: "Box the sticker",
    trim: "Trim to one loop",
    export: "Clean & export",
  };
  const dot: Record<Step, number> = { box: 1, trim: 2, export: 3 };
  const back = () => {
    if (props.step === "box") props.onClose();
    else if (props.step === "trim") props.setStep("box");
    else props.setStep("trim");
  };
  return (
    <>
      <div className="ehead">
        <div className="nav" onClick={back}>
          {props.step === "box" ? "✕" : "‹"}
        </div>
        <div className="etitle">{titles[props.step]}</div>
        <div className="dots">
          {[1, 2, 3].map((d) => (
            <span key={d} className={`d ${dot[props.step] === d ? "on" : ""}`} />
          ))}
        </div>
      </div>
      <div className="ebody">
        {props.step === "box" && (
          <div className="estep entering">
            {props.cropArea}
            <div className="hintline">
              {props.hasCrop
                ? "Drag the handles to fine-tune · pinch to resize"
                : "Drag a box around just the sticker to continue"}
            </div>
            {props.squareToggle}
            <button
              className="primary"
              disabled={!props.hasCrop}
              onClick={() => props.setStep("trim")}
            >
              Next · Trim ›
            </button>
          </div>
        )}
        {props.step === "trim" && (
          <div className="estep entering">
            {props.trimArea}
            <button
              className="primary"
              style={{ marginTop: 18 }}
              onClick={() => props.setStep("export")}
            >
              Next · Export ›
            </button>
            <button
              className="primary ghostbtn"
              onClick={() => props.setStep("box")}
            >
              ‹ Back to box
            </button>
          </div>
        )}
        {props.step === "export" && (
          <div className="estep entering">
            {props.optionToggles}
            <button
              className="primary"
              style={{ margin: "14px 0 6px" }}
              disabled={props.rendering}
              onClick={props.onMakeGif}
            >
              {props.rendering ? "Working…" : "Make GIF"}
            </button>
            {props.statusBlock}
            {props.hasOutputs && (
              <div style={{ marginTop: 12 }}>{props.outputCards(true)}</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function DesktopEditor(props: {
  squareToggle: React.ReactNode;
  cropArea: React.ReactNode;
  crop: Rect | null;
  onClearBox: () => void;
  trimArea: React.ReactNode;
  optionToggles: React.ReactNode;
  statusBlock: React.ReactNode;
  rendering: boolean;
  hasOutputs: boolean;
  onMakeGif: () => void;
  outputCards: (withSend: boolean) => React.ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <div className="ehead" style={{ justifyContent: "space-between" }}>
        <div className="logo">
          steal-a-<span className="g">gif</span>
        </div>
        <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
          <button className="changeclip" onClick={props.onClose}>
            Change clip
          </button>
          <button className="nav" onClick={props.onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="deditor-body">
        <div className="deditor-left">
          {props.squareToggle}
          {props.cropArea}
          {props.crop && (
            <div style={{ textAlign: "center" }}>
              <button className="clearbox" onClick={props.onClearBox}>
                Clear box
              </button>
            </div>
          )}
        </div>
        <div className="deditor-right">
          <div className="panel">
            <p className="ptitle">Trim to one loop</p>
            {props.trimArea ?? (
              <div className="cap" style={{ textAlign: "left" }}>
                Draw a box around the sticker on the left to start trimming.
              </div>
            )}
          </div>
          <div className="panel">
            <p className="ptitle">Options</p>
            {props.optionToggles}
            <button
              className="primary"
              style={{ marginTop: 12 }}
              disabled={props.rendering || !props.crop}
              onClick={props.onMakeGif}
            >
              {props.rendering ? "Working…" : "Make GIF"}
            </button>
            {props.statusBlock}
          </div>
          {props.hasOutputs && (
            <div className="panel">
              <p className="ptitle">Export · two sizes ready</p>
              {props.outputCards(true)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
