# steal-a-gif

Recover a clean, downloadable GIF from a **screen recording** of an animation
that a platform refuses to let you save — WeChat stickers, TikTok, Xiaohongshu,
etc.

Everything runs **client-side** in the browser. Your recording never leaves the
machine: no upload, no server, no per-image cost.

## How it works

```
screen recording
   │  decode.ts        WebCodecs / requestVideoFrameCallback → frames
   ▼
frames
   │  loopDetect.ts    fingerprint frames, find the loop period & cleanest seam
   ▼
one clean cycle
   │  autoCrop.ts      per-pixel motion map → tight bounding box of the animation
   ▼
tight crop
   │  bgKey.ts          (optional) flood-fill the flat app background from the edges
   ▼
matted frames
   │  encodeGif.ts     gifenc, with a "fit to N bytes" loop for Slack's 128KB cap
   ▼
GIF  (native size + 128px Slack emoji)
```

### The interesting bits

- **Loop detection** (`src/pipeline/loopDetect.ts`) — a screen capture has
  partial cycles and junk at the head/tail. We reduce each frame to a 16×16
  grayscale fingerprint and autocorrelate to find the period, then pick the
  start offset whose loop seam is smoothest. This is what makes the output
  loop seamlessly instead of stuttering.
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
- [ ] WebCodecs fast path (currently uses the `<video>` + rVFC fallback)
- [ ] Temporal smoothing / swap ISNet for **Robust Video Matting** to kill
      per-frame edge flicker
- [ ] Manual override handles for the auto-detected crop & loop range
- [ ] Loop-quality score surfaced in the UI; let the user nudge start/end frame
- [ ] APNG / WebP export (smaller + truecolor) alongside GIF

## Why this is feasible

The whole core — decode frames, segment per frame on WebGPU, composite — is a
solved problem in the browser today (see Xenova's WebGPU video background
removal demo). We're assembling proven pieces; the novel work is the loop and
crop detection above.
