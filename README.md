# LLM Image Translate

A Chrome extension that translates the text inside images — manga, memes,
screenshots, menus, product photos — and draws the translation back onto the
picture.

## Using it

Hold **⌘** (Super on other systems) and a badge appears on each image. Click it
to translate; click it again to get the original back, or to cancel a
translation that is still running. The translated image is a real image, so
you can save it.

The popup picks the languages and the profile. Everything else is under
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

Each combination is a profile, and you can switch between them from the popup.

## Install

Download the zip from the releases page, unzip it, open `chrome://extensions`,
turn on **Developer mode**, and pick the folder with **Load unpacked**.

To build it yourself:

```bash
npm install
tools/fetch-ocr-models.sh
npm run build
```

Then load `extension/` the same way.

## Known weak spots

- Japanese names often come back with the wrong reading.
- Sound effects in manga translate badly.
- Text over a busy background is covered with a flat colour, which shows.

## Licence

MIT. ONNX Runtime and the PP-OCR models are under their own licences, listed in
`THIRD_PARTY_NOTICES.txt`.
