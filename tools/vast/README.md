# HY-OCR on Vast

Tests the deployment choices discussed for HunyuanOCR-1.5:

| Configuration | Runtime | Weights |
| --- | --- | --- |
| q8-mac | llama.cpp CUDA | Q8_0 GGUF + Q8 projector (exact Mac files) |
| f16 | llama.cpp CUDA | F16 GGUF |
| q8 | llama.cpp CUDA | Q8_0 GGUF (Mac baseline format) |
| q5 | llama.cpp CUDA | Q5_K_M GGUF |
| q4 | llama.cpp CUDA | Q4_K_M GGUF |
| vllm | vLLM | official BF16 weights |
| dflash | vLLM + DFlash | official BF16 + draft weights |

The q8-mac case matches the model and Q8 projector revision confirmed in the
Mac server log. Other GGUF cases use the same F16 vision projector.
Quantized vLLM and llama.cpp DFlash are not included: those require separate
model/kernel compatibility validation. These are HY-OCR variants, not an
OpenRouter model sweep or a translation benchmark.

## Prepare the rental

Choose one desktop RTX 5090, a CUDA 13 **development** image, a compatible
host driver, at least 32 GB system RAM and about 80 GB disk. Setup needs git,
cmake, a C++ compiler, nvcc, and uv on PATH. No public inference port is needed;
run the benchmark over SSH on the rental. Scripts do not rent or destroy instances.

Copy only `tools/vast/` and the desired source images to the instance (do not
upload the entire repository, which contains local keys). For example, after
SSH connection details are available:

```sh
scp -P PORT -r tools/vast USER@HOST:/workspace/vast
scp -P PORT test/fixtures/pages/{wechat-chat,tweets-thread,leaflet-story}.png USER@HOST:/workspace/
```

On the rental:

```sh
bash /workspace/vast/setup.sh
/workspace/hyocr-bench/venv/bin/python /workspace/vast/bench.py \
  /workspace/wechat-chat.png /workspace/tweets-thread.png /workspace/leaflet-story.png \
  --out /workspace/results-5090
```

Include real dense manga pages in the image list. Setup pins source/model
revisions and vLLM; it records installed Python packages in `packages.txt`.
The CUDA stack remains untested until a rental is available. If installation
or a configuration fails, preserve its logs rather than silently substituting
another runtime. Upstream setup reference:
https://github.com/Tencent-Hunyuan/HunyuanOCR/blob/f2d2ec989c3b96dcc46a1f434e1032fd12c459d8/docs/inference/inference.md

Select a subset with `--configs q8 vllm`; launch one server manually with
`bash /workspace/vast/serve.sh q8`. `BENCH_ROOT`, `PORT`, `GPU`, and `CTX`
override `/workspace/hyocr-bench`, 8090, 0, and 8192 respectively. The 8192
context matches our local server; larger inputs may need a larger value on
both machines. Setup targets CUDA architecture 120 (desktop RTX 5090).

## Mac baseline

Use the same images, dimensions, output limit and Pillow version:

```sh
poc/.venv/bin/python tools/vast/bench.py \
  test/fixtures/pages/wechat-chat.png test/fixtures/pages/tweets-thread.png \
  test/fixtures/pages/leaflet-story.png \
  --endpoint http://127.0.0.1:8090 --model hyocr --label mac-q8 \
  --out /tmp/results-mac
```

If the local server requires its registered model ID, replace `--model hyocr`
with the ID from `/v1/models`. Model sleep/startup is excluded by warmup.

## Read the results

Each configuration warms every image once, then runs three sequential measured
passes. Identical PNG bytes and their SHA-256 hashes are saved in request
metadata (the image bytes themselves are not duplicated in results). llama.cpp
requests disable prompt reuse; vLLM disables prefix and multimodal caches.
Temperature is zero and repetition penalty is 1 for both runtimes, matching
the app comparison rather than upstream's 1.08 repetition penalty.

- `summary.json`: median page latency, time to first text, end-to-end TPS,
  server decode TPS when supplied, error/empty/truncation counts.
- `<config>/requests.jsonl`: all responses, token counts, text, parsed boxes,
  image hashes, warmups, and native timing fields.
- `<config>/server.log`: startup, CUDA, prefill/decode and DFlash diagnostics.
- `gpu.txt`: driver, GPU, power limits and hardware metadata.

TTFT includes image encoding inside the server and prefill; it is not pure
prefill time. vLLM's OpenAI response does not provide llama.cpp-style stage
timings, so unavailable decode rates remain null. End-to-end TPS uses reported
completion tokens divided by complete streamed request time. Never equate it
with server-only decode TPS. This is an app-workload comparison, not a
reproduction of the paper's OmniDocBench benchmark.

Inspect OCR outputs alongside timing: missing lines, changed characters and
bad boxes can make a fast result unusable. Saved Mac output is a comparison
baseline, not ground truth. BF16-vLLM versus Q8-llama changes both runtime and
precision; F16-llama provides a closer precision control. Changing GPUs still
changes more than bandwidth, so this does not isolate bandwidth causally.

Use a fresh output directory each time. Interrupted runs retain completed
request rows. Failed configurations are recorded and the matrix continues;
any failure, empty answer or truncation makes the command exit nonzero.
Copy results and `packages.txt` off the machine before destroying the rental.
