# Dev scripts

Browser-driven helpers that run the real app in headless Chrome via
`puppeteer-core` (a devDependency that uses your **system** Chrome — no
download). They drive a **running dev server**, so start one first:

```bash
npm run dev          # serves on http://localhost:5173
```

Then in another terminal:

| Command | What it does |
| --- | --- |
| `npm run e2e` | End-to-end: load a sample, draw a box, Box→Trim→Export→Make GIF. Asserts the box is mandatory and two outputs are produced; prints the decode-crop size. |
| `npm run scroll-test` | Overflows the chat thread and asserts it scrolls top↔bottom (guards the flexbox scroll bug). |
| `npm run thumbs` | Regenerates `*.thumb.png` for every video in `public/samples`. `SQUARE=xhs-smelly.MP4 npm run thumbs` also writes a square `*.before.png`. |

Overrides: `CHROME=/path/to/chrome` (browser), `URL=http://localhost:PORT/`
(dev server). On a non-default port: `URL=http://localhost:5199/ npm run e2e`.
