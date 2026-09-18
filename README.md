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

## Running it

```bash
cd poc && ./start.sh        # reader on :8090, translator on :8091
npm install && npm run build
```

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
why it is still a preset:

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

**Fits** text to the shape it sits in rather than the box the glyphs occupied. A
flood fill outward finds the speech balloon; growth is capped by how much text
there is, so a one-glyph sound effect cannot claim a whole bubble, and
neighbouring boxes are negotiated so none paints over another.

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
| `json-boxes` | a vision model that answers `[x0, y0, x1, y1]` |
| `json-boxes-yx` | one that answers `[y0, x0, y1, x1]` — Gemini does |
| `gemma-raw` | TranslateGemma's fixed prompt, local only |
| `chat-lines` | any instruct model, numbered lines in and out |
| `hunyuan-mt` | Hy-MT2, which answers to one fixed instruction |

`kind` picks the path: `chat` is `/v1/chat/completions`, which anything
OpenAI-compatible serves, and `completion` is llama.cpp's raw prompt endpoint,
which only a local server has. TranslateGemma needs the raw one, so it is marked
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
a guess, and the preset pairs the two.

## Which models

**Start from** on the settings page is three tested pairings: local llama.cpp,
Gemini 3.1 Flash Lite with Hunyuan MT2, and Qwen3-VL with Hunyuan MT2. Picking
one fills in both endpoints and both adapters, and leaves your API key alone.

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
script detection, the untranslated check, container negotiation — and the
page-side pieces under jsdom.
