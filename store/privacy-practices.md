# Chrome Web Store: privacy practices tab

## Single purpose

Translates the text inside images on web pages and draws the translation back
onto the image.

## Permission justifications

**storage**: Keeps the user's settings (languages, chosen translator, sites to
translate automatically) and timing history for the history page.

**offscreen**: The text reader (ONNX Runtime with WebGPU or WebAssembly) and
Chrome's Translator API need a document, which the service worker does not
have. The offscreen document runs them.

**declarativeNetRequestWithHostAccess**: One static rule adds a Referer header
to the extension's own requests for images on i.pximg.net. Pixiv's image
server refuses requests without it, so Pixiv images could not be translated.

**Host permission (<all_urls>)**: The user can translate an image on any site,
so the content script that places the translate badge has to run on any site,
and the extension has to download the image from wherever the page loaded it.
It also lets the user's chosen translator be reached at whatever address they
entered.

## Remote code

No. All code, the OCR models and ONNX Runtime's WebAssembly ship in the
package. The only network requests are for images on the page and to the
translation service the user picked.

## Data usage

Tick:
- **Website content**: the text read from images is sent to the translation
  service the user selects (OpenRouter, OpenAI, or a server the user entered),
  and only when they ask for a translation.
- **Authentication information**: the user's OpenRouter API key or ChatGPT
  sign-in, kept locally and sent only to that service.

Certify all three:
- not sold or transferred to third parties outside the approved use cases
- not used for purposes unrelated to the item's single purpose
- not used to determine creditworthiness or for lending

## Privacy policy URL

https://github.com/rinpatch/llm-image-translate/blob/main/docs/privacy.md
