# Image translate

An image goes in; the same image comes out with its text translated. Everything
runs locally.

```
image ─→ HunyuanOCR 1B ─→ boxes + text ─→ group ─→ TranslateGemma 4B ─→ paint over ─→ image
         reads, locates                   blocks   translates          and typeset
```

## Running it

```bash
./start.sh          # brings up both models and the demo
open http://127.0.0.1:8000
./stop.sh
```

First run downloads about 3.5 GB of weights into the HuggingFace cache and takes
several minutes. After that it is seconds. The reader listens on 8090 and the
translator on 8091 — 8080 is popular enough that something else usually has it.

```bash
./setup.sh          # optional: the inpainting model, another 198 MB
```

Both scripts read the environment, so a different translator is one variable:

```bash
# a general instruct model instead of the translation-specific one
MT_MODEL=Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M MT_STYLE=chat MT_ARGS= ./start.sh
```

`MT_STYLE` picks how the translator is spoken to. `chat` sends a numbered list
over `/v1/chat/completions` and suits any instruct model. `gemma` is for
TranslateGemma, which is trained on one fixed prompt and whose chat template
refuses a plain string outright — the server will not even start with jinja on.
The pipeline builds that prompt by hand and posts it to `/completion`.

## Why two models

HunyuanOCR reads and locates text better than anything else this size — it read
a dark-mode phone screenshot correctly where Tesseract returned `RO RH GH 四` for
the status bar. It also translates, and well: 76.5 on MMTIT other→English at 1B,
beating Qwen3-VL-8B. But its benchmarks are `other2en`, `other2zh` and `en2zh`,
where *other* means neither Chinese nor English. Chinese as a source is the one
combination never measured, and it shows: asked for it, the model extracts the
text, announces `翻译成英文为`, and repeats the original.

So one model reads and a second translates. A single Qwen3-VL-4B does all three
jobs in one pass and is worth revisiting — it grouped paragraphs better than the
geometry does — but it missed the header and status bar entirely, and rendered
葱 as "Garlic".

## What the pipeline does

**Reads** with the `spotting_hunyuan` task, whose output is `TEXT(x0,y0),(x1,y1)`
run together, normalised to 0-1000. The JSON variant of the same task is a prompt
the model largely ignores.

**Groups** lines into blocks. Horizontal lines join the block above them; vertical
CJK columns join the block to their right, since that is the direction Japanese
is read in. Without this a manga page comes back as 43 separate 28-pixel columns.

**Translates** every block in one request, numbered, so the blocks are context for
each other. The source language is detected from the script and named in the
prompt — without it, `晴山空` comes back as "Qing Shan Kuo", a Chinese reading of
a Japanese name.

**Fits** the text to the shape it sits in, not the box the glyphs occupied. A
flood fill outward from the text finds the speech balloon; growth is capped by how
much text there is, and neighbouring boxes are negotiated against each other so
one cannot paint over another.

**Paints over** the original. A flat fill sampled from around the block is
indistinguishable from real inpainting on a plain background, which is most
screenshots. LaMa is available for textured backgrounds but is off by default:
it is slow, and on line art it makes things worse.

## Flags in the demo

- **fit bubbles** — on. The shape fitting above.
- **inpaint busy backgrounds** — off. LaMa, ~9s per region.

## What it is bad at

**Japanese names.** Readings get invented, though less wildly than before:
`晴山空` (Haruyama Sora) comes back as "Harayama", where a general 7B produced
"Aoyama Sora" and a 3B produced "Clear Mountain Sky". Readings are genuinely ambiguous, which is
why manga prints furigana beside the kanji — and the OCR reads that gloss as its
own column, which then gets translated as if it were words. Correct readings need
a name glossary or a much larger model.

**Sound effects.** `ぼ` becomes "P". Manga translators usually leave them alone.

**Text with no container.** If the flood fill finds no enclosing shape, the block
keeps its original bounds, and a long translation in a short box goes small.

## Files

| | |
| --- | --- |
| `pipeline.py` | read, group, translate, fit, paint |
| `inpaint.py` | LaMa, glyph-level masks, the flat/textured decision |
| `server.py` | HTTP layer for the demo |
| `index.html` | the demo page |
| `start.sh` `stop.sh` `setup.sh` | the above |
