// Generate the social share card (Open Graph / Twitter) for steal-a-gif.
// Renders an SVG -> public/og.png (1200x630) and public/og-square.png
// (1200x1200) with @resvg/resvg-js — no headless browser needed.
//
//   node scripts/og-card.cjs
//
// The brand fonts (Baloo 2, Nunito) are variable TTFs fetched once into
// scripts/.fonts/ (gitignored). The before/after demo reuses the same sample
// art as the in-app intro, so the card always matches what the site shows.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.join(__dirname, "..");
const SAMPLES = path.join(ROOT, "public", "samples");
const FONTDIR = path.join(__dirname, ".fonts");

const FONTS = {
  "Baloo2.ttf":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/Baloo2%5Bwght%5D.ttf",
  "Nunito.ttf":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito%5Bwght%5D.ttf",
};

const get = (url, dest) =>
  new Promise((ok, no) => {
    const f = fs.createWriteStream(dest);
    https
      .get(url, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          return no(new Error(`${r.statusCode} for ${url}`));
        }
        r.pipe(f);
        f.on("finish", () => f.close(ok));
      })
      .on("error", no);
  });

async function ensureFonts() {
  fs.mkdirSync(FONTDIR, { recursive: true });
  for (const [name, url] of Object.entries(FONTS)) {
    const dest = path.join(FONTDIR, name);
    if (!fs.existsSync(dest)) {
      process.stdout.write(`fetching ${name}… `);
      await get(url, dest);
      console.log("ok");
    }
  }
  return Object.keys(FONTS).map((n) => path.join(FONTDIR, n));
}

const dataUri = (file, mime) =>
  `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;

const BEFORE = dataUri(path.join(SAMPLES, "xhs-smelly.before.png"), "image/png");
const AFTER = dataUri(path.join(SAMPLES, "example-export.gif"), "image/gif");

// Brand tokens (mirrors src/styles.css)
const C = {
  bg0: "#f0f1ec",
  bg1: "#e7e9e4",
  bg2: "#dcdfd8",
  ink: "#1c1e1c",
  soft: "#5f635d",
  mint: "#16c079",
  mintDeep: "#0c9c61",
  card: "#ffffff",
  line: "#e3e6e0",
  chkA: "#e7e9e4",
  chkB: "#f5f6f3",
};

// One before/after demo cluster, reused at two aspect ratios.
function demo(cx, cy, tile = 248) {
  const gap = 92;
  const x1 = cx - tile - gap / 2;
  const x2 = cx + gap / 2;
  const y = cy - tile / 2;
  const r = 34;
  const inset = 26; // padding of the artwork inside each tile
  const aw = tile - inset * 2;
  return `
    <g filter="url(#soft)">
      <rect x="${x1}" y="${y}" width="${tile}" height="${tile}" rx="${r}" fill="${C.card}" stroke="${C.line}"/>
      <rect x="${x2}" y="${y}" width="${tile}" height="${tile}" rx="${r}" fill="url(#checker)" stroke="${C.line}"/>
    </g>
    <clipPath id="cb"><rect x="${x1 + inset}" y="${y + inset}" width="${aw}" height="${aw}" rx="14"/></clipPath>
    <clipPath id="ca"><rect x="${x2 + inset}" y="${y + inset}" width="${aw}" height="${aw}" rx="14"/></clipPath>
    <image href="${BEFORE}" x="${x1 + inset}" y="${y + inset}" width="${aw}" height="${aw}" clip-path="url(#cb)" preserveAspectRatio="xMidYMid slice"/>
    <image href="${AFTER}" x="${x2 + inset}" y="${y + inset}" width="${aw}" height="${aw}" clip-path="url(#ca)" preserveAspectRatio="xMidYMid meet"/>
    <g transform="translate(${cx}, ${cy})">
      <circle r="30" fill="${C.mint}"/>
      <path d="M -11 0 H 9 M 2 -8 L 11 0 L 2 8" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </g>`;
}

function defs(w, h) {
  return `
  <defs>
    <radialGradient id="bg" cx="50%" cy="0%" r="120%">
      <stop offset="0%" stop-color="${C.bg0}"/>
      <stop offset="55%" stop-color="${C.bg1}"/>
      <stop offset="100%" stop-color="${C.bg2}"/>
    </radialGradient>
    <pattern id="checker" width="28" height="28" patternUnits="userSpaceOnUse">
      <rect width="28" height="28" fill="${C.chkB}"/>
      <rect width="14" height="14" fill="${C.chkA}"/>
      <rect x="14" y="14" width="14" height="14" fill="${C.chkA}"/>
    </pattern>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#121612" flood-opacity="0.14"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>`;
}

function wordmark(x, y) {
  return `
    <g font-family="Baloo 2" font-weight="800">
      <text x="${x}" y="${y}" font-size="40" fill="${C.ink}">steal-a-<tspan fill="${C.mint}">gif</tspan></text>
    </g>`;
}

function pill(x, y) {
  const label = "no receipts · grab &amp; go";
  return `
    <g>
      <rect x="${x}" y="${y}" width="340" height="52" rx="26" fill="#ffffff" stroke="${C.line}"/>
      <circle cx="${x + 28}" cy="${y + 26}" r="6" fill="${C.mint}"/>
      <text x="${x + 48}" y="${y + 34}" font-family="Nunito" font-weight="700" font-size="22" fill="${C.soft}">${label}</text>
    </g>`;
}

// ---- landscape 1200x630 ----
function landscape() {
  const w = 1200,
    h = 630;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${defs(w, h)}
  ${wordmark(84, 108)}
  <g font-family="Baloo 2" font-weight="800" fill="${C.ink}">
    <text x="80" y="250" font-size="74">Steal any sticker.</text>
    <text x="80" y="338" font-size="74">Keep it <tspan fill="${C.mint}">clean</tspan>.</text>
  </g>
  <g font-family="Nunito" font-weight="600" fill="${C.soft}" font-size="27">
    <text x="84" y="406">Screen-record a sticker from iMessage,</text>
    <text x="84" y="444">TikTok or XHS — get back a clean,</text>
    <text x="84" y="482">transparent GIF. All in your browser.</text>
  </g>
  ${pill(84, 524)}
  ${demo(900, 300, 252)}
</svg>`;
}

// ---- square 1200x1200 ----
function square() {
  const w = 1200,
    h = 1200;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${defs(w, h)}
  <g text-anchor="middle">
    ${wordmark(600, 150)}
    <g font-family="Baloo 2" font-weight="800" fill="${C.ink}" text-anchor="middle">
      <text x="600" y="330" font-size="92">Steal any sticker.</text>
      <text x="600" y="438" font-size="92">Keep it <tspan fill="${C.mint}">clean</tspan>.</text>
    </g>
  </g>
  ${demo(600, 700, 320)}
  <g font-family="Nunito" font-weight="600" fill="${C.soft}" font-size="34" text-anchor="middle">
    <text x="600" y="990">Screen-record it. Get back a clean,</text>
    <text x="600" y="1036">transparent GIF — all in your browser.</text>
  </g>
  <g transform="translate(430,1086)">${pill(0, 0)}</g>
</svg>`;
}

(async () => {
  const fontFiles = await ensureFonts();
  const opts = (w) => ({
    fitTo: { mode: "width", value: w },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Nunito" },
  });
  const out = [
    ["og.png", landscape(), 1200],
    ["og-square.png", square(), 1200],
  ];
  for (const [name, svg, w] of out) {
    const png = new Resvg(svg, opts(w)).render().asPng();
    const dest = path.join(ROOT, "public", name);
    fs.writeFileSync(dest, png);
    console.log(`wrote public/${name} (${png.length} bytes)`);
  }
})();
