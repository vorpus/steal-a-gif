// Shared helpers for the dev test/utility scripts. They drive the app in a real
// headless Chrome (puppeteer-core uses the system browser — no download).
//
//   CHROME=/path/to/chrome   override the browser (auto-detected by default)
//   URL=http://localhost:PORT/  the running dev server (default :5173)
const puppeteer = require("puppeteer-core");
const fs = require("fs");

const CHROME =
  process.env.CHROME ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => p && fs.existsSync(p));

const URL = process.env.URL || "http://localhost:5173/";

async function launch() {
  if (!CHROME) {
    throw new Error("No Chrome found — set CHROME=/path/to/chrome");
  }
  return puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
}

module.exports = { launch, URL, CHROME };
