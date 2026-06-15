# steal-a-gif

**That animation you can't download? Screen-record it, and steal it back as a clean GIF — right in your browser.**

WeChat stickers, TikTok loops, Xiaohongshu animations — platforms love to show you something delightful and then refuse to let you save it. `steal-a-gif` turns a throwaway screen recording into a tidy, downloadable GIF: trimmed to a seamless loop, cropped to the animation, background knocked out, and sized to fit even Slack's 128KB emoji cap.

Everything runs **100% client-side**. Your recording never leaves your machine — no upload, no server, no per-image cost, no account.

### 👉 [Try it now — vorpus.github.io/steal-a-gif](https://vorpus.github.io/steal-a-gif/)

## Install

Run it locally in three lines:

```bash
git clone https://github.com/vorpus/steal-a-gif.git
cd steal-a-gif
npm install
npm run dev
```

Open the printed URL, choose a screen recording, drag a box around the animation, and hit **Make GIF**. That's it.

## The hard problems, already solved

Pulling a clean GIF out of a screen recording sounds simple. It isn't. Here's what's already working under the hood:

- **🔁 Loop detection from a 60fps capture.** A 60fps recording of a ~10fps GIF repeats every frame ~6×. We fingerprint frames, collapse the duplicates, recover the GIF's true cadence, and suggest a seamless loop range — then hand you a live looping preview so you own the final call.
- **✂️ Auto-crop to the real animation.** Static app chrome doesn't move between frames; the animation does. A per-pixel variance map across the loop bounds exactly the moving region, stripping dead background and recovering the GIF's true size.
- **🎬 Two-pass, codec-proof decoding.** Fast lossy capture for scrubbing; a full-fidelity re-decode only when you hit *Make GIF*. WebCodecs (H.264) where it's available, with a native-`<video>` slow-play fallback so HEVC iPhone recordings — which most Chrome builds can't touch — still come out complete and at the right speed.
- **🪄 Flicker-free background removal.** Sticker apps draw on a flat, connected background. Instead of AI matting (which happily drops a stylized character while keeping a high-contrast prop), we flood-fill inward from the frame edge: interior outlines survive, and a constant seed color means zero per-frame flicker.
- **📦 Fit-to-budget encoding.** GIF's 256-color palette and Slack's 128KB ceiling are the real enemies. The encoder shrinks resolution first (down to a 72px floor), then trims palette colors, until it fits — because a coarse palette flashes worse than a smaller image.

Want the full architecture and the rationale behind each decision? See **[OVERVIEW.md](OVERVIEW.md)**.

## Contributing

We'd love help. These are the problems we hit and haven't licked yet — grab one:

- [ ] **Can't tell if we're close to the auto-kill memory limit of mobile devices.** Big recordings decoded frame-by-frame can balloon memory, and mobile browsers silently kill the tab with no warning. We need a way to estimate how close we are to the ceiling and degrade gracefully before the OS pulls the plug.
- [ ] **Some browsers can't support all filetypes.** HEVC in Firefox, GIF input anywhere (WebCodecs won't demux it), WebGPU-only matting paths — codec and feature support is a patchwork. We need clearer detection and fallbacks so users aren't met with a silent failure.

See **[OVERVIEW.md](OVERVIEW.md)** for the broader roadmap (AI matting for non-flat backgrounds, APNG/WebP export, temporal smoothing, and more).
