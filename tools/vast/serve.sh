#!/usr/bin/env bash
set -euo pipefail
ROOT=${BENCH_ROOT:-/workspace/hyocr-bench}
PORT=${PORT:-8090}
CTX=${CTX:-8192}
PROJECTOR=f16
DRAFT=${DRAFT:-$ROOT/gguf-draft/HunyuanOCR-dflash-f16.gguf}
draft=()
export CUDA_VISIBLE_DEVICES=${GPU:-0}
case "${1:?Usage: serve.sh f16|q8|q8-mac|q5|q4|vllm|dflash|dflash-llama}" in
  f16) QUANT=F16 ;;
  q8) QUANT=Q8_0 ;;
  q8-mac) QUANT=Q8_0; PROJECTOR=q8_0 ;;
  dflash-llama)
    QUANT=Q8_0
    draft=(--spec-draft-model "$DRAFT" --spec-draft-ngl 99 --spec-draft-n-max 15)
    ;;
  q5) QUANT=Q5_K_M ;;
  q4) QUANT=Q4_K_M ;;
  vllm|dflash)
    export VLLM_USE_FLASHINFER_SAMPLER=0
    export TORCH_CUDA_ARCH_LIST=12.0
    extra=()
    if [[ $1 == dflash ]]; then
      extra+=(--speculative-config "{\"method\":\"dflash\",\"model\":\"$ROOT/model/dflash\",\"num_speculative_tokens\":15}")
    fi
    exec "$ROOT/venv/bin/vllm" serve "$ROOT/model" \
      --served-model-name hyocr --host 127.0.0.1 --port "$PORT" \
      --trust-remote-code --dtype bfloat16 --tensor-parallel-size 1 \
      --max-model-len "$CTX" --max-num-batched-tokens "$CTX" --max-num-seqs 1 \
      --gpu-memory-utilization 0.85 --limit-mm-per-prompt '{"image":1,"video":0}' \
      --no-enable-prefix-caching --mm-processor-cache-gb 0 "${extra[@]}"
    ;;
  *) echo "Unknown configuration: $1" >&2; exit 2 ;;
esac
exec "$ROOT/llama.cpp/build/bin/llama-server" \
  -m "$ROOT/gguf/HunyuanOCR.$QUANT.gguf" \
  --mmproj "$ROOT/gguf/HunyuanOCR.mmproj-$PROJECTOR.gguf" \
  --alias hyocr --host 127.0.0.1 --port "$PORT" \
  -ngl 99 -fa on -c "$CTX" --parallel 1 --cache-ram 0 \
  ${draft[@]+"${draft[@]}"}
