#!/usr/bin/env bash
set -euo pipefail

# Run inside a CUDA 13 development image; the host driver must support CUDA 13.
ROOT=${BENCH_ROOT:-/workspace/hyocr-bench}
mkdir -p "$ROOT"
command -v nvcc >/dev/null
command -v uv >/dev/null
command -v cmake >/dev/null
nvidia-smi
uv venv --python 3.12 "$ROOT/venv"
uv pip install --python "$ROOT/venv/bin/python" 'vllm==0.25.1' runai-model-streamer huggingface_hub pillow packaging ninja
uv pip install --python "$ROOT/venv/bin/python" --no-build-isolation 'flash-attn==2.8.3'

if [[ ! -d "$ROOT/llama.cpp" ]]; then
  git clone https://github.com/ggml-org/llama.cpp.git "$ROOT/llama.cpp"
fi
git -C "$ROOT/llama.cpp" checkout b23701f77d47dad9de834d59ebfcbe25c9e8b46f
cmake -S "$ROOT/llama.cpp" -B "$ROOT/llama.cpp/build" \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/llama.cpp/build" --target llama-server -j "${BUILD_JOBS:-8}"

"$ROOT/venv/bin/hf" download prithivMLmods/HunyuanOCR-1.5-GGUF-Updated \
  HunyuanOCR.F16.gguf HunyuanOCR.Q8_0.gguf \
  HunyuanOCR.Q5_K_M.gguf HunyuanOCR.Q4_K_M.gguf \
  HunyuanOCR.mmproj-f16.gguf HunyuanOCR.mmproj-q8_0.gguf \
  --revision 9ddd3b47beb0de305ecd89a717748bac080d7aee \
  --local-dir "$ROOT/gguf"
"$ROOT/venv/bin/hf" download tencent/HunyuanOCR \
  --revision 47644ecc4fc854efa4f505155158831f36773ee4 \
  --exclude 'v1.0/*' --local-dir "$ROOT/model"
uv pip freeze --python "$ROOT/venv/bin/python" > "$ROOT/packages.txt"
