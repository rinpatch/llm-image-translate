#!/usr/bin/env bash
# Optional: the inpainting model. Everything else downloads itself on first run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v hf >/dev/null || { echo "missing hf (brew install hf)" >&2; exit 1; }
uv sync
hf download Carve/LaMa-ONNX lama_fp32.onnx --local-dir models
echo "inpainting available — tick it in the demo"
