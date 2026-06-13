# steal-a-gif

Recover a clean, downloadable GIF from a **screen recording** of an animation
that a platform refuses to let you save — WeChat stickers, TikTok, Xiaohongshu,
etc.

Everything runs **client-side** in the browser. Your recording never leaves the
machine: no upload, no server, no per-image cost.

## How it works

```
screen recording
   │  decode.ts        PREVIEW: <video> + rVFC (fast, lossy) → scrubber frames
   ▼
frames
   │  loopDetect.ts    dedupe capture duplicates; SUGGEST a loop range
   ▼
distinct frames + suggested range
   │  LoopSelector     MANUAL: scrubber + handles + looping preview → one cycle
   │  CropCanvas       MANUAL: drag a box around the animation
   ▼
range + crop
   │  decode.ts        ACCURATE: re-decode just the chosen time window —
   │                   WebCodecs (H.264) or seek the <video> per frame (HEVC)
   │  autoCrop.ts      (optional) per-pixel motion map → tighten the box
   │  bgKey.ts         (optional) flood-fill the flat app background from edges
   ▼
matted frames
   │  encodeGif.ts     gifenc, with a "fit to N bytes" loop for Slack's 128KB cap
   ▼
GIF  (native size + 128px Slack emoji)
```

The loop and crop are **user-driven** — auto-detection only seeds a starting
guess. No heuristic reliably tells the animation apart from, say, swiping
Control Center open at the end of the clip, so the user owns the final call with
a live preview to confirm the loop is seamless.

**Two-pass decode.** Preview/scrubbing use a fast real-time capture where
dropped frames don't matter. Only when you hit *Make GIF* does it re-decode the
trimmed window at full fidelity. That render path tries WebCodecs first, but
falls back to seeking the `<video>` element frame-by-frame — which uses the
browser's *native* decode, so HEVC screen recordings (what iPhones produce, and
which most Chrome builds can't decode via WebCodecs) still come out complete and
at the right speed.

### The interesting bits

- **Capture-duplicate dedupe** (`src/pipeline/loopDetect.ts`) — a 60fps screen
  capture of a ~10fps GIF repeats each animation frame ~6×. We fingerprint
  frames (16×16 grayscale) and collapse near-identical runs, recovering the
  GIF's true frame sequence and cadence. The scrubber then shows distinct
  frames, not a wall of duplicates. `detectLoop` still scores a suggested
  range (coverage minus seam error), but it's only a starting point.
- **Auto-crop** (`src/pipeline/autoCrop.ts`) — inside the rough box, static app
  chrome doesn't change between frames but the animation does. We take the
  per-pixel variance across the loop and bound the moving region. This both
  removes dead background and finds the GIF's true size.
- **Background removal** (`src/pipeline/bgKey.ts`) — sticker apps draw on a
  flat, connected background color. Rather than AI matting (which does salient-
  object detection and routinely drops a stylized character while keeping a
  high-contrast prop), we flood-fill the background inward from the frame
  border. It only removes pixels connected to the edge, so an interior outline
  that's close in color to the background never gets eaten, and the constant
  seed color means no per-frame flicker. AI matting (`removeBackground.ts`,
  @imgly ISNet) is kept for the harder case of non-flat backgrounds (TikTok).
- **Size budget** (`src/pipeline/encodeGif.ts`) — GIF's 256-color palette and
  Slack's 128KB ceiling are the real constraints. The encoder shrinks palette,
  then resolution, until it fits.

## Getting started

```bash
npm install
npm run dev
```

Open the printed URL, choose a screen recording, drag a box around the
animation, and hit **Make GIF**.

> The default background removal (flood-fill) is pure JS/canvas and needs no
> GPU or model download. The optional AI matting path needs a WebGPU-capable
> browser (Chrome/Edge 113+).

## Status / roadmap

- [x] Pipeline scaffold end-to-end (decode → loop → crop → bg → encode)
- [x] Native + Slack-sized export
- [x] Manual loop selection: scrubber + draggable handles + looping preview
- [x] Manual crop box (auto-tighten optional)
- [x] Manual crop handles (resize the box after drawing)
- [x] WebCodecs decode (every coded frame; `<video>` + rVFC is the fallback)
- [x] Real per-frame timing (GIF uses source cadence, not a guessed fps)
- [ ] GIF input support (WebCodecs can't decode GIF; needs a GIF demuxer)
- [ ] Temporal smoothing / swap ISNet for **Robust Video Matting** to kill
      per-frame edge flicker
- [ ] APNG / WebP export (smaller + truecolor) alongside GIF

## Why this is feasible

The whole core — decode frames, segment per frame on WebGPU, composite — is a
solved problem in the browser today (see Xenova's WebGPU video background
removal demo). We're assembling proven pieces; the novel work is the loop and
crop detection above.
