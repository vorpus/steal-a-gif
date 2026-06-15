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

<p align="center">
  <img alt="build" src="https://img.shields.io/badge/build-passing-brightgreen" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" />
  <img alt="server" src="https://img.shields.io/badge/server-none-blue" />
  <img alt="uploads" src="https://img.shields.io/badge/uploads-zero-success" />
  <img alt="vibes" src="https://img.shields.io/badge/vibes-immaculate-ff1493" />
</p>

---

WeChat stickers, TikTok loops, Xiaohongshu animations. Platforms love showing you something nice and then greying out the save button. `steal-a-gif` takes the screen recording you grabbed in revenge and turns it into a tidy GIF: trimmed to a seamless loop, cropped to the animation, background knocked out, sized small enough for even Slack's 128KB emoji cap.

It all runs in your browser. The recording never leaves your machine. No upload, no server, no account, no per-image bill.

## Install

```bash
git clone https://github.com/vorpus/steal-a-gif.git
cd steal-a-gif
npm install
npm run dev
```

Open the printed URL, pick a screen recording, drag a box around the animation, hit **Make GIF**. Done.

## The hard problems, already solved

The annoying parts of turning a screen recording into a GIF, handled:

- **Loop detection.** A 60fps recording of a 10fps GIF repeats every frame six-ish times. We fingerprint frames, collapse the duplicates, recover the real cadence, and suggest a seamless loop. You confirm it against a live looping preview.
- **Auto-crop.** App chrome holds still, the animation doesn't. A per-pixel variance map across the loop finds exactly the part that moves and crops to it.
- **Codec-proof decode.** WebCodecs where it works, native `<video>` slow-play where it doesn't, so the HEVC recordings your iPhone makes (the ones most Chrome builds choke on) still come out complete and at the right speed.
- **Background removal that doesn't flicker.** Sticker apps draw on a flat background, so we flood-fill in from the edges instead of asking an AI model which pixels are the "subject" (it always picks wrong). Interior outlines survive, nothing flickers frame to frame.
- **Fit-to-budget encoding.** GIF gets 256 colors and Slack gets 128KB. The encoder drops resolution first, then palette, until it fits, because a chunky palette looks worse than a slightly smaller image.

The deep version of all this lives in [OVERVIEW.md](OVERVIEW.md).

## Contributing

PRs welcome. Here's the stuff that still bites us, if you want a fight:

- [ ] **We can't tell when we're about to hit a phone's auto-kill memory limit.** Decode a big recording frame by frame on mobile and the browser quietly executes the tab, no warning. We need to guess how close to the ceiling we are and back off before the OS does it for us.
- [ ] **Browsers don't all support the same filetypes.** HEVC in Firefox, GIF as input anywhere, WebGPU-only matting paths. The support matrix is swiss cheese and right now the failures are mostly silent. We need real detection and graceful fallbacks.

More on the roadmap (AI matting for messy backgrounds, APNG/WebP export, temporal smoothing) over in [OVERVIEW.md](OVERVIEW.md).
