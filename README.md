<h1 align="center">steal-a-gif</h1>

<p align="center">
  Some app won't let you save its animation? Screen-record it and steal it
  back as a clean GIF.
</p>

<p align="center">
  <a href="https://vorpus.github.io/steal-a-gif/"><b>Live demo</b></a>
  ·
  <a href="https://github.com/vorpus/steal-a-gif"><b>GitHub</b></a>
  ·
  <a href="OVERVIEW.md"><b>How it works</b></a>
</p>

---

Screen-record a WeChat sticker, TikTok loop, or Xiaohongshu animation, and `steal-a-gif` turns it into a tidy GIF: trimmed to a seamless loop, cropped to the animation, background removed, small enough for Slack's 128KB emoji cap.

Runs entirely in your browser. No upload, no server, no account.

## Install

```bash
git clone https://github.com/vorpus/steal-a-gif.git
cd steal-a-gif
npm install
npm run dev
```

Open the URL, pick a recording, drag a box around the animation, hit **Make GIF**.

## The hard problems, already solved

- **Loop detection.** A 60fps recording of a 10fps GIF repeats every frame six-ish times. We fingerprint frames, collapse the duplicates, and suggest a seamless loop you confirm against a live preview.
- **Auto-crop.** A per-pixel variance map across the loop finds the part that actually moves and crops to it.
- **Codec-proof decode.** WebCodecs where it works, native `<video>` slow-play where it doesn't, so iPhone HEVC recordings still come out right.
- **Flicker-free background removal.** Flood-fill from the edges instead of asking an AI which pixels are the "subject" (it always picks wrong).
- **Fit-to-budget encoding.** Drops resolution first, then palette, until it fits under Slack's cap.

Details in [OVERVIEW.md](OVERVIEW.md).

## Contributing

PRs welcome. Stuff that still bites us:

- [ ] **We can't tell when we're near a phone's auto-kill memory limit.** Mobile browsers quietly kill the tab on big recordings, no warning.
- [ ] **Browsers don't all support the same filetypes.** HEVC in Firefox, GIF as input, WebGPU-only paths. Detection and fallbacks needed.
