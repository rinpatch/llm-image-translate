# In-Place Translate

A Chrome extension that translates the page you are reading, in place, using
Apple's on-device Translation framework. No screenshots, no OCR, no API key, no
network round trip — the DOM text goes straight to the same translator macOS
uses for Live Text.

Extensions cannot call native frameworks, so a small Swift binary sits behind
Chrome's native messaging as the bridge:

```
content.js  →  background.js  →  translator-host (Swift)  →  Translation.framework
   DOM            port              stdin/stdout                   on-device
```

## Requirements

- macOS 26 or newer. The headless `TranslationSession(installedSource:target:)`
  used here does not exist on earlier versions, where the framework had to be
  anchored to a SwiftUI view.
- Xcode command line tools (for `swift build`).
- A Chromium-based browser: Chrome, Chromium, Brave, Edge, Vivaldi, or Arc.

## Install

```bash
./install.sh
```

That builds the host, installs it to `~/Library/Application Support/InPlaceTranslate`,
and writes the native messaging manifest into every Chromium profile it finds.
Then load `extension/` as an unpacked extension from `chrome://extensions` with
developer mode on, and restart the browser.

The extension ID is pinned by the `key` field in `extension/manifest.json`, so
the manifest written by `install.sh` keeps matching across reloads.

## Language packs

Translation is offline, which means the language pair has to be on the machine
first. There is no API to download one silently — add pairs under **System
Settings → General → Language & Region → Translation Languages**. Until then the
popup reports `needs_download` and points you there.

## Using it

Click the toolbar icon, pick a target language, hit Translate — or press
⌥⇧T. Restore puts the original text back. While a page stays translated, a
MutationObserver picks up content that loads later, so infinite scroll and SPA
navigation keep translating.

Text nodes, plus `placeholder`, `title`, `alt`, and `aria-label`, are
translated. `<script>`, `<style>`, `<pre>`, `<code>`, editable regions, and
anything marked `translate="no"` or `.notranslate` are left alone.

## Native host protocol

Newline-free JSON with Chrome's 4-byte length prefix, over stdin/stdout:

| Request | Response |
| --- | --- |
| `{"id":1,"action":"ping"}` | `{"id":1,"ok":true,"status":"ready"}` |
| `{"id":2,"action":"availability","source":"en","target":"ja"}` | `{"ok":true,"status":"installed\|supported\|unsupported"}` |
| `{"id":3,"action":"prepare","source":"en","target":"ja"}` | `{"ok":true,"status":"..."}` |
| `{"id":4,"action":"translate","source":"auto","target":"ja","texts":[...]}` | `{"ok":true,"source":"en","translations":[...]}` |

`source: "auto"` runs `NLLanguageRecognizer` over the joined batch. Failures come
back as `{"ok":false,"code":"needs_download"\|"unsupported"\|"undetected"\|"bad_request"\|"translation_failed"}`.

You can drive it by hand:

```bash
python3 - <<'PY'
import json, struct, subprocess
p = subprocess.Popen(["native/.build/release/translator-host"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
msg = json.dumps({"id": 1, "action": "translate", "source": "auto",
                  "target": "ja", "texts": ["Hello, world"]}).encode()
p.stdin.write(struct.pack("=I", len(msg)) + msg); p.stdin.flush()
n = struct.unpack("=I", p.stdout.read(4))[0]
print(json.loads(p.stdout.read(n)))
PY
```

## Tests

```bash
npm install && npm test
```

Runs the content script against jsdom: whitespace handling, skip rules,
dedup, idempotent re-runs, observer pickup, and restore.

## Firefox

Firefox uses the same native messaging protocol but a different manifest
location (`~/Library/Application Support/Mozilla/NativeMessagingHosts/`) with
`allowed_extensions` instead of `allowed_origins`, and its MV3 needs
`background.scripts` rather than a service worker. The Swift host works as-is;
the extension needs those two edits.
