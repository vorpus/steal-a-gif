// Regression test for the chat thread scroll. Overflows the thread and checks
// that scrollTop can reach the top, middle, and bottom (and RETURN to the top —
// the flexbox "overflowed top is unreachable" bug clamps that >0). Guards
// against re-breaking the scroll while tweaking the thread/composer layout.
//
//   npm run dev
//   node scripts/scroll-test.cjs
const { launch, URL } = require("./lib.cjs");

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 700 });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1800));

  const res = await page.evaluate(() => {
    const thread = document.querySelector(".thread");
    const inner = document.querySelector(".thread-inner");
    if (!thread || !inner) return { error: "no thread/.inner" };
    for (let i = 0; i < 40; i++) {
      const row = document.createElement("div");
      row.className = i % 3 === 0 ? "row out" : "row";
      row.innerHTML = '<div class="bub">fake message ' + i + "</div>";
      inner.appendChild(row);
    }
    const o = { maxScroll: thread.scrollHeight - thread.clientHeight };
    o.overflows = thread.scrollHeight > thread.clientHeight;
    thread.scrollTop = 0; o.canReachTop = thread.scrollTop;
    thread.scrollTop = Math.floor(o.maxScroll / 2); o.midGot = thread.scrollTop;
    thread.scrollTop = 999999; o.canReachBottom = thread.scrollTop;
    thread.scrollTop = 0; o.canReturnToTop = thread.scrollTop;
    return o;
  });

  console.log(JSON.stringify(res, null, 2));
  const ok =
    res.overflows &&
    res.canReachTop === 0 &&
    res.canReturnToTop === 0 &&
    res.canReachBottom === res.maxScroll;
  console.log(ok ? "SCROLL: OK" : "SCROLL: BROKEN");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
