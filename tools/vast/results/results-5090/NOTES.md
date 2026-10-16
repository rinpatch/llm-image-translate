# HY-OCR on one RTX 5090 — run of 2026-09-19

Instance 51557627, 1x RTX 5090, driver 595.58.03, nvcc 12.8, vLLM 0.25.1,
llama.cpp b23701f77 plus PR 28890. Six images, three measured passes each after
one warmup. Medians across all 18 measured requests per config.

| config | wall s | TTFT s | e2e tok/s | server decode tok/s |
| --- | --- | --- | --- | --- |
| q8-mac | 1.30 | 0.413 | 552 | 807 |
| f16 | 1.48 | 0.422 | 493 | 683 |
| q8 | 1.32 | 0.427 | 553 | 805 |
| q5 | 1.36 | 0.428 | 521 | 760 |
| q4 | 1.38 | 0.430 | 524 | 761 |
| vllm | 1.20 | 0.153 | 579 | n/a |
| dflash | 3.03 | 0.164 | 237 | n/a |
| dflash-llama | 2.52 | 0.437 | 281 | 336 |

`vllm` and `dflash` live in `../results-5090-vllm/`; the same-named folders here
hold the failed first attempt and its logs. `summary-merged.json` is the table
above; each config's own `summary.json` is untouched.

## What the numbers say

vLLM wins on time to first text by about 2.7x (0.15s against 0.41s) — that gap
is image encode plus prefill, not decode. On whole-page latency the two runtimes
land within 10% of each other.

Quantization barely moves decode between Q8 and Q4 (807 to 761 tok/s) while F16
is the slowest llama.cpp case at 683. Q8_0 is the sweet spot, and `q8-mac` (the
Q8 projector the Mac serves) matches `q8` (F16 projector) to within noise, so
the projector precision is not worth arguing about.

**DFlash loses badly in both runtimes** — 3.03s under vLLM and 2.52s under
llama.cpp, against 1.20s and 1.32s without it. llama.cpp reports why: draft
acceptance 0.031, against the ~0.5 the PR author measured. At 3% the draft is
rejected almost every time and its cost is pure overhead. Acceptance was
identical against the Q8_0 and F16 targets, so quantization is not the cause,
and the vLLM `dflash` run used tencent's official BF16 target with its official
draft and lost just as badly, so weight provenance is not the cause either.

The cause is the workload. 66% of the output characters are coordinate digits
and punctuation - `(288,30),(709,52)` - and pixel coordinates carry no
structure a draft model can predict. Over the whole run the llama.cpp server
reports 223 accepted of 9270 drafted, 2.4%, mean accepted length 1.36. With
`n_max=15` that is fifteen draft forwards plus verification per step to gain
about a third of a token, which is where the 2x goes.

The PR author's ~0.5 acceptance was almost certainly measured on plain text
recognition rather than this coordinate-emitting prompt. Speculation may still
pay off for a text-only OCR prompt; it cannot for this one, and lowering
`n_max` would only shrink the loss rather than turn it into a win.

Spot counts are deterministic within a config (all three passes identical) and
agree across configs to a few spots on the dense manga pages. `dflash` and
`vllm` do differ slightly (47 vs 45 spots on 1.png), so speculation here is not
producing output identical to the non-speculative run.

## Deviations from setup.sh, all of them deliberate

- **flash-attn was never installed.** Its source build was going to take the
  better part of an hour on 16 threads. vLLM 0.25.1 ran without it; `packages.txt`
  shows no flash-attn. The pinned install in `setup.sh` looks unnecessary.
- **vLLM needed two env vars**, now in `serve.sh`: FlashInfer's JIT arch check
  reports sm120 as below sm75 and kills the engine while building the sampler.
- **vLLM 0.25.1 needed a one-line patch** to
  `vllm/model_executor/models/hunyuan_vision.py`: the VL class' `forward()`
  takes `intermediate_tensors` and `inputs_embeds` positionally while the runner
  passes neither, so every vLLM run died at startup. Giving both `= None`
  matches what `hunyuan_v1.py` already does. The original is beside it as
  `hunyuan_vision.py.orig`. This patch is NOT in the repo — a rerun needs it
  applied again, or a vLLM version where it is fixed upstream.
- **`setup.sh` passed the file list to `--include`**, which `hf download`
  ignores outright ("filenames have been explicitly set"). F16.gguf was silently
  skipped and `f16` would have failed on any run. Fixed in `setup.sh`.

## p_min sweep (M4 Pro, added after the rental was destroyed)

Acceptance is a property of target, draft and prompt, not of the GPU, so this
ran locally on the Mac: same Q8_0 target and q8_0 projector the Mac serves, the
same draft re-converted from tencent's weights, two coordinate-heavy pages, two
measured passes. llama.cpp built at the same pin with PR 28890 applied.

| p_min | drafted | accepted | acceptance | mean len | wall s | decode tok/s |
| --- | --- | --- | --- | --- | --- | --- |
| no draft | - | - | - | - | 5.36 | 198 |
| 0.00 | 5670 | 228 | 4.0% | 1.60 | 10.46 | 66 |
| 0.50 | 770 | 218 | 28.3% | 1.82 | 7.60 | 105 |
| 0.75 | 406 | 192 | 47.3% | 1.98 | 7.38 | 108 |
| 0.90 | 301 | 177 | 58.8% | 2.14 | 7.38 | 108 |

The benchmark ran at llama.cpp's default `p_min=0.00`, which never stops a
draft however unsure it is. Raising it to 0.9 cuts drafted tokens 19x while
losing only 22% of the accepted ones: the confidence floor separates the text
runs from the coordinate digits on its own, no grammar needed. Acceptance then
reaches 0.588, which is where the PR author's ~0.5 comes from - that number was
a p_min setting, not a different model or a different workload.

Speculation still loses. 7.38s at best against 5.36s with no draft at all;
p_min turns a 1.95x loss into a 1.38x one. Even at the best setting the draft
contributes 177 accepted tokens across the whole run while every decode step
pays a draft forward and a longer verify.

What this does not settle: the draft is block-diffusion, meant to propose 16
tokens in one parallel forward verified in a single target pass. `mean len`
around 2 says llama.cpp's chain-style loop is not using it that way. The draft
card states real speedup is only realized under vLLM nightly and points at a
DFlash-adapted llama.cpp fork. So these numbers measure this PR's integration,
not what DFlash can do.
