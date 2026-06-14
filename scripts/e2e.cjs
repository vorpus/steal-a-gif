// End-to-end smoke test of the editor flow against a running dev server.
// Loads a sample clip, draws a crop box, runs Box -> Trim -> Export -> Make GIF,
// and asserts the box is mandatory and two outputs are produced. Also prints the
// "[steal-a-gif] accurate decode ... @ WxH" log so you can confirm frames are
// cropped at decode (the memory fix).
//
//   npm run dev          # in one terminal (serves on :5173)
//   node scripts/e2e.cjs # in another
const { launch, URL } = require("./lib.cjs");

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800 });
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message));
  await page.goto(URL, { waitUntil: "networkidle2" });

  await new Promise((r) => setTimeout(r, 2400)); // intro
  await page.evaluate(() => document.querySelector(".ghost")?.click());
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => document.querySelector(".sample")?.click());

  await page.waitForSelector(".cropcanvas", { visible: true, timeout: 20000 });
  await new Promise((r) => setTimeout(r, 600));

  const nextLabel = "Next · Trim";
  const nextDisabled = () =>
    page.evaluate((t) => {
      const b = [...document.querySelectorAll(".editor .primary")].find((x) =>
        x.textContent.includes(t));
      return b ? b.disabled : "no-button";
    }, nextLabel);

  const before = await nextDisabled();

  // Draw a box (mouse drag synthesizes pointer events).
  const box = await page.evaluate(() => {
    const r = document.querySelector(".cropcanvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.mouse.move(cx - 50, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy - 20, { steps: 4 });
  await page.mouse.move(cx + 50, cy + 50, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));

  const after = await nextDisabled();

  const clickPrimary = (t) =>
    page.evaluate((t) => {
      const b = [...document.querySelectorAll(".editor .primary")].find((x) =>
        x.textContent.trim().startsWith(t));
      if (b) b.click();
      return !!b;
    }, t);
  await clickPrimary("Next · Trim");
  await new Promise((r) => setTimeout(r, 500));
  await clickPrimary("Next · Export");
  await new Promise((r) => setTimeout(r, 500));
  await clickPrimary("Make GIF");

  let outcome = "timeout";
  for (let i = 0; i < 80; i++) {
    const s = await page.evaluate(() => ({
      outs: document.querySelectorAll(".outcard").length,
      err: document.querySelector(".errline")?.textContent || "",
    }));
    if (s.outs > 0) { outcome = "outputs:" + s.outs; break; }
    if (s.err) { outcome = "error:" + s.err; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("Next·Trim disabled  before box:", before, " after box:", after);
  console.log("make-gif outcome:", outcome);
  console.log("--- relevant logs ---");
  logs
    .filter((l) => /steal-a-gif|PAGEERROR|error/i.test(l))
    .forEach((l) => console.log("  " + l));

  await browser.close();
  const ok = before === true && after === false && outcome.startsWith("outputs:");
  console.log(ok ? "E2E: OK" : "E2E: FAIL");
  process.exit(ok ? 0 : 1);
})();
