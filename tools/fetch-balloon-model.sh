#!/bin/bash
# Puts the speech-balloon segmenter into extension/vendor/ocr/balloons.onnx.
#
#     tools/fetch-balloon-model.sh && npm run build
#
# A development build runs without it, setting every translation in its own
# block's box; scripts/package.sh refuses to make a release without it.
#
# YOLO11-nano trained on Manga109's balloons (huyvux3005/manga109-segmentation-
# bubble), as exported to ONNX by a third party, unchanged. Apache-2.0 on the
# weights; Manga109 itself is licensed for academic use.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/extension/vendor/ocr
rev=6839b4ea9d95be14f5bbd21ac675d92a7da95ed0
url=https://huggingface.co/mednasserallah/manga109-segmentation-bubble-onnx/resolve/$rev/manga109_segmentation_bubble_1024.onnx
sha=593cae61f4c9ffc773fee34d55c28069390d19415c24dc04600f983311618ea3

mkdir -p "$out"
curl -fsSL --retry 3 -o "$out/balloons.onnx.part" "$url"
echo "$sha  $out/balloons.onnx.part" | shasum -a 256 -c - >/dev/null
mv "$out/balloons.onnx.part" "$out/balloons.onnx"
echo "-> $out/balloons.onnx"
