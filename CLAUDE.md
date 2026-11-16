# Testing

Three layers, cheapest first. Most changes only need the first.

```bash
npm test          # tsc --noEmit, then node --test test/
npm run build     # esbuild src/ -> extension/dist/
```

`core/` and `backends/` are pure — no `chrome.*`, no network — so they are imported
and called directly. Anything touching `chrome.storage` gets a hand-written stub
(see the top of `test/settings.test.ts`); anything touching the DOM runs under
jsdom (`test/content.test.ts`). `globalThis.fetch` is replaced outright to fake a
model's reply.

## Driving the real extension

`agent-browser --extension <path>` loads an unpacked extension and gives you a
CDP-driven browser over it. The extension ID is fixed at
`khbiipgidcclbakblacconmmpnacljae`, because `manifest.json` carries a `key` field
(the public half of `tools/extension_key.pem`), so extension pages have a stable
URL you can navigate straight to:

```bash
npm run build     # the manifest points at extension/dist/, not src/
agent-browser --extension "$PWD/extension" \
  open chrome-extension://khbiipgidcclbakblacconmmpnacljae/options.html

agent-browser get text "#history"   # on stats.html
agent-browser screenshot /tmp/options.png
agent-browser errors            # page errors, empty is the pass
agent-browser close --all
```

`AGENT_BROWSER_COLOR_SCHEME=light` on that first command is how you see the light
half of `extension/ui.css`; the flag form of it cannot start a browser.

Only the first command of a session needs `--extension`; the rest attach to the
browser it left running. `close --all` is what picks up a rebuild — an MV3 worker
keeps the `dist/` it started with. It also takes the profile with it, so
`chrome.storage` starts empty every session and anything a test needs in there
has to be seeded again.

Do not reach for stable Chrome and `--load-extension`. Chrome removed it: on 151
it is accepted, logs nothing, and leaves `extensions.settings` empty in the
profile, so the extension URL fails with `ERR_BLOCKED_BY_CLIENT` and it looks
like the extension is broken rather than absent. `--enable-unsafe-extension-debugging`
does not bring it back. agent-browser drives Chrome for Testing, which still
honours it.

## Reaching the worker from a page

An extension page shares the extension's origin, so `eval` there can talk to the
MV3 service worker and to storage directly. That gets at the pipeline without
hunting for a badge to click:

```bash
agent-browser eval 'chrome.runtime.sendMessage({type:"metrics"}).then(JSON.stringify)'
agent-browser eval 'chrome.runtime.sendMessage({type:"log"}).then(JSON.stringify)'
agent-browser eval 'chrome.storage.local.set({metrics: [...]}).then(() => "ok")'
```

`translateImage` takes a `dataUrl`, so a whole translation can be driven from
here with no page and no image server — pass a throwaway `src` for the cache key
and put the real bytes in `dataUrl`. Build the call in a file and pass it as
`agent-browser eval "$(cat script.js)"`; a base64 PNG is too big to quote inline
by hand.

Two calls with the same bytes is the check that `once()` still dedupes: the
second comes back with timings identical to the first, and `metrics` reports one
run rather than two.

## Grouping, without the browser

`test/fixtures/spots/` holds what the reader saw on each of those pages — the
lines, the ink at each line and at its two ends, and which pairs the pixels
divide. That is grouping's whole input, so `test/grouping.test.ts` runs the real
`group()` over real pages in node, in milliseconds. Reach for it first when
changing `core/grouping.ts`: it says how many pieces each page came apart in,
which a unit test over three invented boxes cannot.

```bash
tools/dump-spots.sh                   # re-record every page
tools/dump-spots.sh pages/tweets-thread manga-page
```

Re-record when the reader or `dividerFor` changes — never to make a failing
count pass. The counts in `PIECES` were each judged against a render.

The fixtures there now were recorded with HunyuanOCR, a vision model the
extension no longer has. `dump-spots.sh` records with PP-OCR, so the first
re-record changes every page's lines at once, and each count in `PIECES` has
to be judged against a render again rather than carried over.

`tools/ablate-grouping.mjs` deletes each of grouping's rules in turn and
re-groups every page, which is how to tell whether a rule is still earning its
place. Every rule currently breaks at least one page when removed; one that
breaks none is either dead or has no fixture arguing for it, and both are worth
knowing before adding the next one.

## Scoring the reader

`tools/bench-readers.ts` runs the extension's PP-OCR over pages whose true boxes
are known and prints what it located, read, and how close its boxes were. It
drives a real Chrome, so it needs `npm run build` and
`tools/fetch-ocr-models.sh` first, and takes a browser launch to get going.

```bash
node tools/bench-readers.ts
node tools/bench-readers.ts --runs 3
node tools/bench-readers.ts --json /tmp/gold.json
node tools/bench-readers.ts --compare /tmp/gold.json
```

The pages come from `tools/make-truth.py`, which draws them and writes the boxes
it drew beside them — the truth is the generator's arithmetic, not somebody's
tracing. They are drawn inside the reader's `maxDim` so nothing is scaled. Both
a PNG and a JPEG are written, from when readers differed in which they took.
Regenerate with:

```bash
uv run tools/make-truth.py
```

Two traps in there. Songti's face 0 is Songti SC **Black**, whose glyph set has
holes — 聞, 語, 間 and a dozen more come out blank, which looks like a reader
failure and is not. Face 1 is complete. And a good reader takes both pages
22/22, so the counts catch a regression but will not show a small improvement;
mean IoU is what moves.

## The reader that runs in the browser

`ppocr-browser`, the only reader there is. It runs in the extension, so there
is nothing to start.

```bash
npm install
tools/fetch-ocr-models.sh    # weights + wasm -> extension/vendor/ocr/, gitignored
npm run build
```

The weights are downloaded, pinned to a RapidOCR release. `charset.txt` is built
there too: the published dictionary is the 18708 characters, the model has 18710
outputs, and the missing two are CTC's blank at the front and a space at the
back — which is why the script checks the count and why `engine.ts` splits the
file on `\n` alone. Trimming it would lose exactly that space.

There is a third model beside them: PP-OCRv5's Korean recogniser, because
the general one has no Hangul and reads a Korean line as a stray digit. It
replaces the general one when Translate from is Korean, and on Auto it reads
every line too and wins only where its reading has Hangul in it — without that
check it reads a Japanese line as a lone `1` at 0.99 confidence.

It lives in an offscreen document (`src/offscreen.ts`), not the worker, because
a service worker is evicted after thirty seconds idle and has no `Worker`. The
worker creates the document on demand (`src/platform/offscreen.ts`) and reaches
it by message; `backends/client.ts` calls that through a seam installed by the
worker, so `backends/` still touches no `chrome.*`.

Everything the Python package gets from OpenCV is in
`src/backends/ocr/ppocr/` — `db.ts` turns the probability map into quads,
`ctc.ts` reads the recogniser's slices back into text, and `engine.ts` does the
resizing and the crops through a canvas. The first two are pure and
`test/ppocr.test.ts` runs them in node.

Three things to know before changing it:

**Sessions are built one at a time.** The WebGPU backend refuses to create a
second session while one is being created, and doing it in a `Promise.all`
fails with `another WebGPU EP inference session is being created`.

**Reads go one at a time.** Two reads at once lock the offscreen document up,
warm or cold, and every extension page shares its process, so the settings page
hangs too. `read()` in `src/offscreen.ts` chains them; translating every image on
a site is what first started two together.

**ONNX Runtime has to be told where its WebAssembly is.** The bundle is one
file, so there is no script URL for it to work its own location out from;
`ort.env.wasm.wasmPaths` is set in `engine.ts` and the symptom of forgetting is
`cannot determine the script source URL`.

To drive it by hand, an extension page can create the document and ask directly:

```bash
agent-browser eval "(async () => {
  await chrome.offscreen.createDocument({url:'offscreen.html',
    reasons:['WORKERS'], justification:'ocr'}).catch(()=>{});
  const r = await chrome.runtime.sendMessage({target:'offscreen', type:'ocr', image: dataUrl});
  return JSON.stringify(r.timings);
})()"
```

`node tools/bench-readers.ts` scores it against known pages; see above.

## The inpainter

Every block's words are inpainted away: manga-image-translator's AOT-GAN,
22 MB, trained on manga pages. `tools/fetch-inpaint-model.sh` exports it from
their checkpoint, which needs torch through uv. A development build runs
without it. `scripts/package.sh` refuses to make a release without it, since
a release without it would quietly fall back to the flat fill.

Inpainting only the blocks that looked like they sat on art was tried first,
and it missed: grey screentone on a black-and-white page lies on the line
between paper and ink, so no test of the box's colours can tell it from the
antialiasing on a glyph's edge. Translucent bubbles on greyscale pages then got
a white rectangle. On the fixtures, inpainting everything came out the same or
better on every page. On a tweet or a chat bubble it hands back exactly what
the flat fill would. The mask is all the ink in the box, measured against the
paper (below). It starts from the source image, not the flat-filled one, which
has already painted the glyphs over.

The flat fill is what shows without the model, or while the inpainter is still
running and a streamed partial wants painting. It paints only the glyphs, in the
colour read along the inside edge of the box. Strokes that run past a margin
around the box are left alone, because they're the bubble's outline or the
drawing beyond it. So a box can cross a bubble's edge without covering it.
Two things came out of the fixtures:

- **Paper comes from inside the box, not the ring outside.** On manga the ring
  lands on the art around a bubble and comes out bluish grey. Not the commonest
  colour in the whole box either: on lettering filled white and outlined in
  colour (`banner-large`), that is the letters' own fill.
- **If more ink crosses the margin than stays inside, the box is filled whole.**
  That covers white letters stroked black straight onto a photo
  (`korean-caption`): nothing around them is paper, so every glyph looks like
  an outline. Text on paper keeps 8–57% of its box as glyphs; the failures kept
  none.

Every block copies from one composite. Copying a block's surroundings from a
picture its neighbour wasn't cleaned in puts the neighbour's words back along
the seam.

It runs in the offscreen document, in the same queue as reads, in parallel with
translation: about 1–1.5 s for a manga page on WebGPU, one model call per
cluster of blocks. The stats page draws that run on a lane under the stages
(`alongside` in `src/platform/metrics.ts`). On the main bar it shows only as
"Inpaint, past translation", the time painting waited for it once the
translation was in. With a slow local translator that is nothing. With Chrome's
translator it is most of the inpainter's time. Two traps:

- **No `convertToBlob` in the offscreen document.** It is never visible, and in
  a hidden document that call waits about a second for a frame, every time.
  The reply is encoded through a DOM canvas's `toDataURL` instead (4 ms).
- **Nothing under ~68 px a side.** The graph dilates by 16 at quarter scale
  and pads by reflection, which throws on anything smaller. `regionsFor` asks
  for 128 and `aot.ts` scales anything smaller up.

## Chrome's own translator

`chrome-translator` hands the lines to Chrome's Translator API, in the offscreen
document beside the reader, because the service worker does not have the API.
A language pair has to be downloaded once, and only on a click on a visible
page. The offscreen document can never get a click, so the settings page has a
Download button for it. After that the document needs no click. Chrome asks
again for every origin, even when it already holds the pack: on the extension's
origin a pack fetched for another site still says `downloadable`, and
"downloading" it takes ~100 ms.

Helium cannot use it at all. Its component updater fetches only CRLSet and
Widevine, so a pack never arrives: no progress event, no error, a `create()`
that never settles. `downloadPack` says so after 20 s without progress; Chrome
sends its first one in about 4.

Chrome for Testing cannot test this. Its language packs never finish
downloading, headless or headed. Stable Chrome fetches one in ~10 s, but it will
not take `--load-extension` (see above). What works is puppeteer-core's
`enableExtensions`, which loads the unpacked extension over the pipe with CDP's
`Extensions.loadUnpacked`:

```js
// npm i puppeteer-core in the scratchpad, not here
puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, pipe: true,
  enableExtensions: ['/Users/rin/sw/image-translate/extension'],
  ignoreDefaultArgs: true,
  args: ['--user-data-dir=<fresh dir>', '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging', '--remote-debugging-port=9333',
    '--no-first-run'],
});
```

Keep the node process alive afterwards (`setInterval`). An unsettled top-level
`await` lets node exit, and Chrome goes with it.

Three traps:

- **`ignoreDefaultArgs: true` is required.** Puppeteer's defaults include
  `--disable-component-update` and `--disable-background-networking`, and with
  either one a download sits at "Downloading…" with no progress and no error. It
  also drops the `--user-data-dir` that `userDataDir` would add, so the profile
  goes in `args`; without it Chrome quietly runs on your default profile.
- **Use a fresh `--user-data-dir` after every rebuild.** A reused profile keeps
  running the service worker it registered first, so the new build's options
  page talks to the old worker. `chrome.runtime.reload()` from a page unloads
  the extension for good.
- **Click through puppeteer** (`page.click`), not `agent-browser --cdp 9333
  click`. The latter reports success and the click never arrives, so there is
  no user gesture.

`agent-browser --cdp 9333 eval` and `get text` still work for reading pages.
Close the extra tabs first, because puppeteer and agent-browser each open their
own copy of the settings page.

## The pages that broke something

`test/fixtures/pages/` holds the images that have caught a real bug, each with a
note in its README on what it catches — a leaning leaflet, a chat window's grey
translation footers, a banner whose four runs of text sit a few pixels apart.

```bash
tools/render-fixtures.sh              # -> .renders/, one PNG and one block list each
tools/render-fixtures.sh /tmp/before Russian
```

It drives the real extension over every one of them and takes about a minute, so
it is the check for anything touching grouping, skew or layout, where a unit test
only says the rule fired and not whether the page came out right. Keep a run from
before the change and compare.

## Seeing what the reader saw

With debug mode on (settings, or `chrome.storage.local.set({debug: true})`) the
worker keeps the last few images: the scaled source, every line the reader
spotted, which block each one was merged into, where the translation was drawn,
and everything logged while that image ran. `chrome-extension://<id>/debug.html`
draws the boxes over the image, one colour per block, so a merge is something to
look at rather than something to infer.

```bash
agent-browser eval "chrome.storage.local.set({debug:true}).then(()=>'on')"
# ... translate something ...
agent-browser open "chrome-extension://khbiipgidcclbakblacconmmpnacljae/debug.html"
agent-browser eval 'chrome.runtime.sendMessage({type:"traces"}).then(JSON.stringify)'
```

They live in IndexedDB, not `chrome.storage.local` — that is a flat 10 MB for
the whole extension and would take the image as base64, which is a third again
on top of a file that was already most of the budget. The last ten are kept, the
page reads the database itself rather than asking the worker to pass megabytes
through a message, and turning debug mode off throws them all away.

## Against the live models

`./macos/install.sh` puts the translator on :8091.
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8091/v1/models` before
blaming the code.

It sleeps after a minute idle, so the first translation after a pause costs
seconds more than the next one — real, and the reason the settings page reports
medians. A test that asserts on a wall-clock number will fail on whichever run
happens to land cold.

`test/fixtures/manga-page.png` is the heavy case: 2297x3123, 7 MB, a dense
Japanese page with 52 spotted lines and furigana. It is the one to reach for when
something is slow; a small sample will not show it. Serve it rather than inlining
it — a 7 MB PNG is ~10 MB as base64, past what `agent-browser eval` can take as
an argument:

```bash
(cd test/fixtures && python3 -m http.server 8777 &)
# then pass src: "http://127.0.0.1:8777/manga-page.png" to translateImage
```

One translation of it takes ~19s end to end, which outruns the agent-browser
daemon's read timeout if you loop over several in a single `eval`. Drive one per
call.

## A small sample

Generate a small CJK sample with Pillow:

```bash
uv run --with pillow python -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (520, 260), 'white'); d = ImageDraw.Draw(img)
f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 40)
d.text((30, 40), '全场包邮', font=f, fill='black'); img.save('/tmp/sample.png')"
```

`/System/Library/Fonts/PingFang.ttc` is there but PIL cannot open it — use
`Supplemental/Songti.ttc`.
