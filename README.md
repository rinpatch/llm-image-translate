# Image Translate

A Chrome extension that translates the text inside images, and a proof of
concept that does the same from the command line. Both run entirely on your own
machine, against a [llama.cpp](https://github.com/ggml-org/llama.cpp) server you
start yourself.

```
<img> ─→ worker ─→ HunyuanOCR ─→ boxes + text ─→ group ─→ TranslateGemma
          fetch,                                              │
        rasterise  ←────────── paint onto a canvas ←──────────┘
```

The worker replaces the image rather than drawing boxes over it, so nothing has
to chase the picture through scrolling, zooming, or a lazily swapped `src` —
and the result is a real image you can save. Clicking the badge again puts the
original back.

Badges appear while ⌘ is held — Super elsewhere — so an ordinary page is left
alone. A badge stays out once its image has been translated, because it is the
only way back to the original and the only way to call a slow translation off.

## Running it

```bash
./macos/install.sh         # reader on :8090, translator on :8091, at login
npm install && npm run build
```

The two models run as launchd agents that start at login. A minute after the
last request they hand their weights back, which takes them from 4.2 GB between
them to 0.34 GB:

| | reader | translator |
| --- | --- | --- |
| working | 2.19 GB | 1.99 GB |
| idle | 0.22 GB | 0.12 GB |
| first request after idling | 4.7s | 3.1s |
| once awake | 0.4s | 0.2s |

The wait is reading the weights back off disk, and it is per model — translating
a picture wakes both, translating the next one wakes neither. If you would rather
have the seconds than the gigabytes, `IDLE=-1 ./macos/install.sh` never sleeps.

`./macos/install.sh --uninstall` takes them out again; logs are in
`~/Library/Logs/image-translate/`.

`poc/start.sh` does the same thing in the foreground, with the browser demo
alongside, and leaves anything already listening alone.

Then load `extension/` from `chrome://extensions` with developer mode on.
`npm run watch` rebuilds on save; the extension still has to be reloaded there
for the worker to pick the new bundle up.

The popup is the two language pickers and nothing else. Everything else — the
endpoints, their adapters, and a button that checks whether they answer — is on
the settings page behind **Settings…**.

Nothing about that is specific to llama.cpp. Point both endpoints at any
OpenAI-compatible service, give them a key and a model, and pick the matching
adapters — **Start from** has tested pairings for both.

`poc/` also has a browser demo of the same pipeline at `http://127.0.0.1:8000`,
which is easier to iterate on. See `poc/README.md`.

## Why two models

HunyuanOCR reads and locates text better than anything else its size, and it
translates well — 76.5 on MMTIT other→English at 1B, beating Qwen3-VL-8B. But
its benchmarks are `other2en`, `other2zh` and `en2zh`, where *other* means
neither Chinese nor English. Chinese as a source is the one combination never
measured, and asked for it the model extracts the text, announces
`翻译成英文为`, and repeats the original.

So one model reads and a second translates. Hy-MT2 1.8B does that job in
1.47 GB — a gigabyte less than TranslateGemma 4B, which it matches on quality —
and it keeps a numbered batch in order, so a page is one request rather than one
per line whenever the reply drifts.

| | reader | translator | total |
| --- | --- | --- | --- |
| Hy-MT2 1.8B Q6_K | 1.31 GB | 1.47 GB | **2.78 GB** |
| TranslateGemma 4B Q4_K_M | 1.31 GB | 2.49 GB | 3.80 GB |

Neither gets `雨宮静久` right at this size; the hosted 30B is the only model
tried that does. TranslateGemma still reads `晴山空` slightly better, which is
why it still has a profile of its own:

```bash
MT_MODEL=bullerwins/translategemma-4b-it-GGUF:Q4_K_M MT_STYLE=gemma \
MT_ARGS=--no-jinja ./start.sh
```

## What it does

**Reads** with the `spotting_hunyuan` task, whose output is `TEXT(x0,y0),(x1,y1)`
run together and normalised to 0-1000.

**Groups** lines into blocks. A rule drawn between two lines keeps them apart
whatever their spacing says: on a price list the wrap inside one cell and the gap
to the next row measured 3px and 19px against a 21px threshold, so without that
check a table comes back as one block per column instead of one per cell. Where
nothing is ruled, the spacing decides as before.

Horizontal lines join the block above them;
vertical CJK columns join the block to their right, which is the direction
Japanese is read in. Without that a manga page arrives as dozens of 28-pixel
columns that no font size will fit English into.

**Translates** the whole page in one request so the blocks are context for each
other, falling back to one request per block if the reply comes back with the
wrong number of lines. Obvious scripts are identified directly; Latin text uses
Chrome's language detector and can be overridden with **Translate from**. The
source is named in the prompt — without it, `晴山空` comes back as "Qing Shan Kuo".

**Leaves blocks alone** when the translation still looks like the source — a
half-translated line drawn over the original is worse than the original.

## What it is bad at

**Japanese names.** Readings get invented: `雨宮静久` (Amamiya Shizuku) comes
back wrong from every model tried. Readings are genuinely ambiguous, which is
why manga prints furigana beside the kanji — and the reader picks that gloss up
as its own column, which then gets translated as if it were words.

**Sound effects.** `ぼ` becomes "P". Manga translators usually leave them alone.

**Backgrounds with texture.** The original is painted over with the dominant
colour around it, which is invisible on a flat background and obvious over a
photograph. Real inpainting needs a model the browser cannot host; `poc/` has it
behind a flag.

## Layout

```
src/core/       geometry, grouping, colour, layout, painting — no chrome, no fetch
src/backends/   what each model wants said to it and how its reply is read
src/pipeline/   rasterise → read → group → translate → lay out → paint
src/platform/   settings, messages, logging: the chrome.* surface
src/content/    the badge layer, the image swap, the page-side result cache
```

`src/offscreen.ts` is the odd one out: a document with no UI, holding the ONNX
sessions for the in-browser reader because the service worker cannot.

`core/` is where the work that has nothing to do with a particular model lives,
so it can be imported and tested directly. Anything a specific model needs said
to it — the spotting prompt, the coordinate format, TranslateGemma's raw chat
template — belongs in `backends/` and nowhere else.

A backend is an endpoint and an adapter. The endpoint is a base URL, an optional
key and a model name; `backends/client.ts` owns every request to one. The
adapter says what to put in the body and how to read the reply back, and never
touches the network:

```ts
build(image)                  → { kind: 'chat', body }     // what to send
parse(content, image)         → TextLine[]                 // boxes, in raster pixels
build(texts, source, target)  → { kind, body }
parse(content, expected)      → (string | null)[] | null
```

There are four:

| adapter | for |
| --- | --- |
| `hunyuan-spotting` | HunyuanOCR's own spotting task |
| `ppocr-browser` | PP-OCR, which is not a language model and runs in the extension |
| `json-boxes` | a vision model that answers `[x0, y0, x1, y1]` |
| `json-boxes-yx` | one that answers `[y0, x0, y1, x1]` — Gemini does |
| `gemma-raw` | TranslateGemma's fixed prompt, local only |
| `chat-lines` | any instruct model, numbered lines in and out |
| `hunyuan-mt` | Hy-MT2, which answers to one fixed instruction |

`kind` picks the path: `chat` is `/v1/chat/completions`, which anything
OpenAI-compatible serves, `completion` is llama.cpp's raw prompt endpoint, which
only a local server has, and `offscreen` is no path at all — the reader is in
this browser, and the request is a message rather than a socket. TranslateGemma needs the raw one, so it is marked
`localOnly` and the settings page says so if you pair it with a hosted service.
The base URL is written either way round — `http://127.0.0.1:8090` or
`https://openrouter.ai/api/v1` — and the version segment is taken off and put
back rather than trusted.

Boxes come back in pixels of the rasterised image, whatever the model emits —
HunyuanOCR's 0-1000 grid is its adapter's business. Normalising them would make
the geometry anisotropic: `isVertical` compares a box's height against its
width, and on a 400x1600 page that comparison flips.

`json-boxes` asks for that same 0-1000 grid, because Qwen3-VL answers on it even
when the prompt spells out the pixel size of the image. A reply that exceeds
1000 anywhere is taken as pixels instead, since the grid cannot.

The axis order is not something a prompt settles. Gemini answers
`[ymin, xmin, ymax, xmax]` however it is asked, and read the other way round its
boxes are not merely wrong but nonsense — so it gets its own adapter rather than
a guess, and a profile pairs the two.

## Which models

A **profile** is a named pair of endpoints — a reader and a translator, each
with its adapter, model and key — and the popup switches between them, so a page
the local models struggle with can go to a hosted one without retyping anything.
Five ship: local llama.cpp, the same with TranslateGemma, PP-OCR in the browser
with Hunyuan MT2, Gemini 3.1 Flash Lite with Hunyuan MT2, and Qwen3-VL with
Hunyuan MT2. They are ordinary profiles once
installed — rename, edit or delete them, and duplicate one to start your own.

Readers were scored against two generated pages whose true boxes are known,
because the pages are drawn rather than found: a clean comic page of nine lines,
and a noisy one of twelve — tilted text, grey on a grey gradient, dense small
print in two languages, a vertical column, and a line that is barely visible at
all. *Located* counts lines matched at IoU > 0.3, *read* counts exact text.

| model | clean | noisy | mean IoU | per image |
| --- | --- | --- | --- | --- |
| `google/gemini-3.1-flash-lite` | 9/9 | 12/12 | 0.93 | $0.0009 |
| `qwen/qwen3.8-flash` | 9/9 | 12/12 | 0.88 | $0.0004 |
| `google/gemini-2.5-flash-lite` | 9/9 | 11/12 | 0.91 | $0.0004 |
| `qwen/qwen3-vl-8b-instruct` | 5/9 | 12/12 | 0.59 | $0.0003 |
| `z-ai/glm-5.3-flash` | 4/9 | — | 0.67 | $0.0008 |
| `bytedance-seed/seed-1.6-flash` | 0/9 | — | — | $0.0006 |

Gemini 3.1 Flash Lite reads and places everything on both pages and is the
fastest tried. Qwen3-VL 8B reads everything too but draws boxes half again too
large, which shows in the replacement. Seed 1.6 answered with round numbers like
`[50, 50, 450, 150]` — it is not looking at the image, so no prompt will fix it.

For translation the difference is smaller but lands on the thing this project is
worst at. Asked for `雨宮静久`, only `tencent/hy-mt2-30b-a3b` — a model trained
for translation rather than chat — answered Amamiya Shizuku; Gemini and the rest
invent Shizuhisa. It is also the cheapest and fastest of them, at $0.00005 a
page. Its one weakness is sound effects: `ドキドキ` becomes "So nervous" where
Gemini says "Thump-thump".

Being a translation model rather than a chat model is also why it has its own
adapter. Asked for JSON it translates the instructions along with the text and
answers in prose — the task done, in the wrong shape. Given the one instruction
Tencent documents, with the lines numbered inside the text being translated, it
answers in order every time.

### Reading without a language model

PP-OCRv6 is not a VLM, and nothing about it needs a server. A segmentation net
finds the ink and returns the quad around it; a CTC head reads each crop and
says how sure it is. So it cannot invent a box where nothing is written, every
line arrives with a confidence, and all of it fits in the extension: the two
graphs run on ONNX Runtime's WebGPU backend, and everything the reference
implementation gets from OpenCV — the resizing, the crops, the contours, the
decode — is `src/backends/ocr/ppocr/`. Pick **PP-OCR in the browser** and there
is nothing to install and nothing to start; only the translator is a server.

Scored against the same pages, with the local VLM for comparison:

| reader | located | read | mean IoU | read in | weights |
| --- | --- | --- | --- | --- | --- |
| HunyuanOCR 1B | 22/22 | 22/22 | 0.91 | 1.9s | 1.31 GB |
| PP-OCRv6 small | 21/22 | 21/22 | 0.91 | 0.3s | 30 MB |

Six times faster off a fortieth of the weights, placing lines as well. What it
loses is the line at the edge of visible — grey on grey a shade apart, which no
threshold recovers, because the detector's probability map has nothing there to
threshold. That is the shape of the trade generally: a detector is better than a
VLM at ordinary print and worse at anything stylised, faint or hand-drawn, which
is why both ship rather than one replacing the other.

Its boxes are grown outward from the ink by `unclipRatio`, whose upstream
default of 1.6 puts about four pixels of background on every side — most of the
box on 15px small print, and mean IoU 0.78 rather than 0.91. It is set to 1.2 in
`src/backends/ocr/ppocr/db.ts`.

It runs in an offscreen document rather than in the service worker, which is
forced rather than chosen. A service worker is evicted after thirty seconds
idle, so every click would reload 30 MB of weights and recompile the shaders,
and it has no `Worker`, so WebAssembly cannot be threaded there. A document has
neither problem. What it does not have is any extension API but `chrome.runtime`
— no storage, no tabs — and nothing can wake one, so the worker stays the brain
and the document only ever answers the one question.

WebGPU is what makes it worth doing: the detector is about 50ms there against
555ms for the same graph on the CPU provider, which is kept only as a fallback
for machines without it.

`tools/fetch-ocr-models.sh` downloads the weights into `extension/vendor/ocr/`,
pinned to the RapidOCR release they were exported from. They are not committed.

Avoid reasoning models at both jobs. They spend the budget thinking about a
mechanical task — one returned 2048 tokens of reasoning and no answer at all.

## Giving up

Clicking a badge that is already working calls the request off — the only way to
say "never mind" to a model that is taking its time — and leaving the page calls
off whatever it was still waiting for. Both reach the socket: the request is
aborted, not merely ignored.

A job shared by two tabs stops only when the last tab waiting on it has gone,
and every request has a 90-second ceiling regardless, because a hung fetch holds
the service worker awake for as long as it lasts.

## What comes back from a model

Two lines in, one line out, and every line after it is attributed to the wrong
box. `chat-lines` numbers them, so a model that merges or drops one loses only
that line; the rest of the batch stands and the gaps are asked for again, three
at a time. `gemma-raw` cannot — TranslateGemma is trained on one fixed prompt and
would translate the numbers — so a drifted reply there costs the whole page.

Replies arrive fenced, wrapped in prose, or after a block of reasoning holding
the model's own rejected drafts of the answer. `backends/json.ts` takes the last
balanced JSON value after any `</think>`, which is the answer in each case. A
reasoning model still burns its thinking on your bill for no benefit here, so
prefer one that does not.

## Settings

An endpoint is a base URL, an optional key, an optional model name, and the
adapter to drive it with. There are two of them, one per role, and they can name
the same server.

**Test both endpoints** asks each for `/v1/models` rather than llama.cpp's
`/health`, which a hosted service does not serve — and a key that is wrong fails
there the same way it would fail in earnest.

**Timings** is a page of its own, linked from the settings footer and the popup.
It holds the median of the last 200 images, stage by stage, with the time to
the first token and the tokens per second each model managed. Every run records
the profile that ran it and the page reports one profile at a time, picked at the
top: a local reader and a hosted one are seconds apart, so a median over both
describes neither. The picker appears once a second profile has translated
something, and opens on whichever ran last. A profile renamed after the fact
keeps its old runs under the old name — the history says what was used, not what
it is called now. Those two come from
the `timings` block llama.cpp puts beside its answer; a hosted OpenAI-compatible
server reports token counts at best, so the rate there includes the network and
there is no prefill figure at all. Medians rather than means, because the first
request after the models have handed their weights back costs seconds and would
otherwise colour the whole window. The slowest run is shown beside the total so
that cost stays visible instead of being smoothed away.

Timings are recorded where the work happens rather than at the badge, so a second
click on the same image — answered from the worker's cache — is not counted.

Under them is the history: one row per image, newest first, opening on to its
stages. Failures are in there too — they are the rows worth having — with the
error the pipeline gave up. A row holds the image's URL and never the image, so
a `blob:` or `data:` one is logged as `(inline image)`, and a URL long enough to
be a payload in its own right is cut at 200 characters.

Preferences — the two languages and whether badges appear — live in synced
storage and are the only thing a content script is told. Endpoints live in local
storage, because a content script runs inside whatever site you are on, and
because synced storage is copied to Google with the rest of the profile. The
popup and the settings page are extension pages, so they read both directly.

## Tests

```bash
npm install && npm test
```

Type-checks, then runs the geometry and language logic against strings the
reader actually returned — spot parsing, row and column grouping, CJK joining,
script detection, the untranslated check — and the
page-side pieces under jsdom.
