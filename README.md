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

The popup has the two server URLs under **llama.cpp servers** if you run them
somewhere else, and reports whether it can reach them.

`poc/` also has a browser demo of the same pipeline at `http://127.0.0.1:8000`,
which is easier to iterate on. See `poc/README.md`.

## Why two models

HunyuanOCR reads and locates text better than anything else its size, and it
translates well — 76.5 on MMTIT other→English at 1B, beating Qwen3-VL-8B. But
its benchmarks are `other2en`, `other2zh` and `en2zh`, where *other* means
neither Chinese nor English. Chinese as a source is the one combination never
measured, and asked for it the model extracts the text, announces
`翻译成英文为`, and repeats the original.

So one model reads and a second translates. TranslateGemma was the best of the
translators tried: it renders `晴山空` as "Harayama" where a general 7B produced
"Aoyama Sora" and a 3B produced "Clear Mountain Sky", and it is half the size.

## What it does

**Reads** with the `spotting_hunyuan` task, whose output is `TEXT(x0,y0),(x1,y1)`
run together and normalised to 0-1000.

**Groups** lines into blocks. Horizontal lines join the block above them;
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
parse(content, image)         → TextLine[]                 // boxes, normalised
build(texts, source, target)  → { kind, body }
parse(content, expected)      → string[] | null            // null: lines drifted
```

`kind` picks the path: `chat` is `/v1/chat/completions`, which anything
OpenAI-compatible serves, and `completion` is llama.cpp's raw prompt endpoint,
which only a local server has. TranslateGemma needs the raw one, so it is marked
`localOnly`.

## Tests

```bash
npm install && npm test
```

Type-checks, then runs the geometry and language logic against strings the
reader actually returned — spot parsing, row and column grouping, CJK joining,
script detection, the untranslated check, container negotiation — and the
page-side pieces under jsdom.
