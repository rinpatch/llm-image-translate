#!/bin/bash
# Puts everything the reader needs into extension/vendor/ocr/.
#
#     npm install && tools/fetch-ocr-models.sh && npm run build
#
# The weights come from RapidOCR's published ONNX exports of PP-OCRv6, pinned to
# the release they were cut from — this is where the Python package would fetch
# them too. Nothing in vendor/ is committed; this script is the record of what
# is in there and where it came from.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/extension/vendor/ocr
models=https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2

[ -d "$root/node_modules/onnxruntime-web" ] || { echo "npm install first" >&2; exit 1; }
mkdir -p "$out"
cd "$root"

# Detection and recognition, in their small tier. The angle classifier is left
# out: it only decides whether a crop is upside down, which costs a pass per
# line and has yet to change an answer on any fixture here.
curl -fsSL --retry 3 -o "$out/PP-OCRv6_det_small.onnx" \
  "$models/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx"
curl -fsSL --retry 3 -o "$out/PP-OCRv6_rec_small.onnx" \
  "$models/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx"

# The recogniser's classes. The published dictionary is the 18708 characters
# without CTC's blank at the front or the space at the back, and the model has
# 18710 outputs — so both are put in here, and the file is then a straight
# index-to-character table that src/backends/ocr/ppocr/engine.ts splits on \n
# and nothing else. Trimming it would lose exactly the space.
dict=$(mktemp)
trap 'rm -f "$dict"' EXIT
curl -fsSL --retry 3 -o "$dict" \
  "$models/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt"
{ printf 'blank\n'; sed -e '$a\' "$dict"; printf ' '; } > "$out/charset.txt"

classes=$(wc -l < "$out/charset.txt" | tr -d ' ')
[ "$classes" -eq 18709 ] || { echo "charset is $((classes + 1)) entries, expected 18710" >&2; exit 1; }

# The general recogniser has no Hangul at all. Korean has its own, a PP-OCRv5
# one since there is no v6 for it yet, with only Hangul and Latin in it. Its
# table is laid out the same way: 11945 entries, 11947 outputs.
curl -fsSL --retry 3 -o "$out/korean_PP-OCRv5_rec_mobile.onnx" \
  "$models/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx"
curl -fsSL --retry 3 -o "$dict" \
  "$models/paddle/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt"
{ printf 'blank\n'; sed -e '$a\' "$dict"; printf ' '; } > "$out/charset-korean.txt"

classes=$(wc -l < "$out/charset-korean.txt" | tr -d ' ')
[ "$classes" -eq 11946 ] || { echo "Korean charset is $((classes + 1)) entries, expected 11947" >&2; exit 1; }

# One WebAssembly build serves both providers: ONNX Runtime 1.30 asks for the
# asyncify pair when WebGPU is the backend, and the same binary carries the CPU
# kernels the wasm provider falls back to. The loader beside it is fetched by
# name, so both files have to be here under exactly these names.
for file in ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  cp "node_modules/onnxruntime-web/dist/$file" "$out/$file"
done

du -sh "$out"
ls -la "$out" | awk 'NR>3 {printf "  %8.1f KB  %s\n", $5/1024, $9}'
