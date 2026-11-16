# LLM Image Translate

A Chrome extension that translates the text inside images — manga, memes,
screenshots, menus, product photos — and draws the translation back onto the
picture.

## Using it

Hold **⌘** (Super on other systems) and a badge appears on each image. Click it
to translate; click it again to get the original back, or to cancel a
translation that is still running. The translated image is a real image, so
you can save it.

The popup picks the languages and the translator. Everything else is under
**Settings…**.

## How it works

The text is read inside the browser with PP-OCR, so nothing needs installing
for that. Translation can go to:

- **Chrome's built-in translator** — the default. Free, private, nothing to
  set up, but fairly rough.
- **A model on your own machine** — any OpenAI-compatible server, such as
  llama.cpp. Much better, still private. See
  [Setting up local translation](docs/local-translation.md).
- **A hosted model** on OpenRouter — the best results, for a fraction of a cent
  per image.
- **A ChatGPT plan** — signed in from the settings page, and counted against
  the plan's usage.

## Install

Download the zip from the releases page, unzip it, open `chrome://extensions`,
turn on **Developer mode**, and pick the folder with **Load unpacked**.

To build it yourself:

```bash
npm install
tools/fetch-ocr-models.sh
tools/fetch-inpaint-model.sh   # needs uv; see below
npm run build
```

The second script fetches a small inpainter trained on manga, which redraws
whatever was behind the original words. It exports the model from a PyTorch
checkpoint, so it needs `uv`. A build without it still runs, but the words are
painted over in the background's colour, which shows wherever that background
is a picture.

Then load `extension/` the same way.

## Known weak spots

- Japanese names often come back with the wrong reading.
- Sound effects in manga translate badly.

## Licence

GPL-3.0, in `LICENSE`. The inpainting model comes from
[manga-image-translator](https://github.com/zyddnys/manga-image-translator),
which is GPL-3.0 too. ONNX Runtime and the PP-OCR models are under their own
licences, listed in `THIRD_PARTY_NOTICES.txt`.
