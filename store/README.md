# Chrome Web Store listing

`listing-<lang>.md` is the text to paste into each language's listing, and
`privacy-practices.md` the answers for the privacy tab. `images/<lang>/` is
what to upload: `f1`–`f5` as screenshots, `tile` as the small promo tile,
`marquee` as the marquee.

The images are `frames.html` screenshotted by `render.sh <lang>`, with the
words from `strings.js`. The art in `sources/` is our own, drawn in HTML, so
nobody else's comic is in the listing. `sources/<name>-<lang>.png` is each one
run through the real extension on the ChatGPT plan, and `shots/` holds the
extension's own UI, captured per language by `capture-ui.sh`. The Chinese set
starts from `banner-ko`, since a Chinese banner translated into Chinese shows
nothing.

Re-translate a source after changing it or the pipeline: open an extension
page in agent-browser, set the target in `chrome.storage.sync`, and send
`translateImage` with the served file as `src`, as CLAUDE.md describes.
