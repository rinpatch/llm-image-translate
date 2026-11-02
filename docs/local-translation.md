# Setting up local LLM translation

The extension has two halves:
1. **Reading** is done locally inside the extension using `PP-OCR`.
2. **Translating** uses Chrome's built-in translator or needs an external OpenAI-compatible LLM.

It's recommended to set up a local model for better local translations, as Chrome's translator is quite rudimentary. In my testing on an M4 Pro Mac I found `Hy-MT2-1.8B-GGUF:Q6_K` provides a good balance between translation quality and performance. To use it with llama.cpp, run the following:
```sh
llama-server -hf tencent/Hy-MT2-1.8B-GGUF:Q6_K --host 127.0.0.1 --port 8091 \
  -fa on -c 8192 --sleep-idle-seconds 60
```

Then set the extension to use OpenAI-compatible model at `http://127.0.0.1:8091`.

`Hy-MT2-1.8B-GGUF:Q6_K` uses 4GB of RAM, so you might not want to keep it loaded in memory on a personal computer. Fortunately, we can automatically unload the model when not in use using the `sleep-idle-seconds` option in `llama.cpp`, when unloaded the server only consumes ~100MB of memory, however the next translation will have to wait while the weights are loaded (around 2 seconds on M4 Pro).

## Setting up on MacOS with auto-scaling
`macos/install.sh` in the LLM Image Translate repository starts the translator at login and keeps them running in the background.

1. Install llama.cpp:

   ```bash
   brew install llama.cpp
   ```
2. Fetch and run the script. The first run downloads the models, which takes a few minutes:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/rinpatch/llm-image-translate/main/macos/install.sh | bash
   ```
3. Check that the translator answers. `200` means it is up:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/v1/models
   ```

### Uninstalling
To remove everything, run:

```bash
launchctl bootout gui/$UID/me.wantan.llm-image-translate.translator
rm ~/Library/LaunchAgents/me.wantan.llm-image-translate.translator.plist
rm -r ~/Library/Logs/llm-image-translate
```

The downloaded model stays in `~/.cache/huggingface` until you delete them.
