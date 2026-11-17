# Privacy policy

LLM Image Translate has no server of its own. It collects nothing, sells
nothing, and sends nothing to its author.

## What leaves your computer

**The words in an image, to the translator you picked.** The text is read
inside your browser. The image itself is not sent anywhere. Only the words
read from it go to the translator chosen in the settings:

- Chrome's built-in translator, which runs on your computer.
- OpenRouter, under [its privacy policy](https://openrouter.ai/privacy), if
  you entered an OpenRouter key.
- OpenAI, under [its privacy policy](https://openai.com/policies/privacy-policy),
  if you signed in with ChatGPT.
- A server whose address you entered yourself.

Nothing is translated until you click an image's badge, or until you turn on
automatic translation for a site.

**Image requests, to the site the image is on.** To read an image, the
extension downloads it from wherever the page loaded it, as the page itself
did.

**Your sign-in, to OpenAI.** Signing in with ChatGPT goes through OpenAI's own
sign-in page. Signing out tells OpenAI to end that session.

## What stays on your computer

- API keys and the ChatGPT sign-in, in the extension's own storage, where web
  pages cannot read them. Each is sent only to the service it belongs to.
- Your settings, including the sites you turned automatic translation on for.
  The language choices are kept in Chrome's sync storage, so they follow your
  Chrome profile if Chrome sync is on.
- Timings for the history page. Recent translations are also kept in memory,
  so an image is not translated twice, until the browser closes.
- With debug mode on, the last ten images and what was read from them.
  Turning debug mode off deletes them.

Removing the extension deletes all of it.

## Contact

Questions go to the issue tracker:
https://github.com/rinpatch/llm-image-translate/issues
