// Regenerate sample-tile thumbnails: for every video in public/samples, grab
// its first frame and write <name>.thumb.png (used as the tile image). Pass
// SQUARE=<name.MP4> to also write <name>.before.png (a centre-cropped square,
// for the intro before/after demo). Uses the running dev server to serve files.
//
//   npm run dev
//   node scripts/extract-thumbnails.cjs
//   SQUARE=xhs-smelly.MP4 node scripts/extract-thumbnails.cjs
const fs = require("fs");
const path = require("path");
const { launch, URL } = require("./lib.cjs");

const DIR = path.join(__dirname, "..", "public", "samples");
const SQUARE = process.env.SQUARE || "";

(async () => {
  const videos = fs
    .readdirSync(DIR)
    .filter((f) => /\.(mp4|mov|m4v)$/i.test(f));
  if (videos.length === 0) {
    console.log("No videos found in public/samples");
    return;
  }

  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  for (const file of videos) {
    const square = file === SQUARE;
    try {
      const res = await page.evaluate(async (file, square) => {
        const v = document.createElement("video");
        v.src = "/samples/" + file;
        v.muted = true;
        await new Promise((ok, no) => {
          v.onloadeddata = ok;
          v.onerror = () => no(new Error("decode/load failed"));
          setTimeout(() => no(new Error("timeout")), 12000);
        });
        await new Promise((ok) => { v.onseeked = ok; v.currentTime = 0.05; });
        const vw = v.videoWidth, vh = v.videoHeight;
        const scale = Math.min(1, 360 / Math.max(vw, vh));
        const tw = Math.round(vw * scale), th = Math.round(vh * scale);
        const c = document.createElement("canvas");
        c.width = tw; c.height = th;
        c.getContext("2d").drawImage(v, 0, 0, tw, th);
        const out = { thumb: c.toDataURL("image/png"), vw, vh };
        if (square) {
          const s = Math.min(vw, vh), S = 256;
          const sc = document.createElement("canvas");
          sc.width = S; sc.height = S;
          sc.getContext("2d").drawImage(v, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, S, S);
          out.square = sc.toDataURL("image/png");
        }
        return out;
      }, file, square);

      const base = file.replace(/\.[^.]+$/, "");
      const write = (dataUrl, name) =>
        fs.writeFileSync(path.join(DIR, name), Buffer.from(dataUrl.split(",")[1], "base64"));
      write(res.thumb, `${base}.thumb.png`);
      if (res.square) write(res.square, `${base}.before.png`);
      console.log(`OK  ${file} (${res.vw}x${res.vh}) -> ${base}.thumb.png${res.square ? " + " + base + ".before.png" : ""}`);
    } catch (e) {
      console.log(`FAIL ${file}: ${e.message}`);
    }
  }
  await browser.close();
})();
