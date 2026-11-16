#!/bin/bash
# Puts the manga inpainter into extension/vendor/ocr/aot-inpaint.onnx.
#
#     tools/fetch-inpaint-model.sh && npm run build
#
# A development build runs without it, painting the glyphs out in the paper's
# colour; scripts/package.sh refuses to make a release without it.
#
# The weights are manga-image-translator's AOT-GAN, trained on manga pages. They
# are published only as a PyTorch checkpoint, so it is exported to ONNX here,
# with the network definition from the same project pinned to a commit. That
# needs torch, which uv fetches into its cache rather than into this repo.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/extension/vendor/ocr
repo=https://raw.githubusercontent.com/zyddnys/manga-image-translator/a9ef04da0adda877413afe40b7656aebe22dc4be
ckpt=https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/inpainting.ckpt
sha=878d541c68648969bc1b042a6e997f3a58e49b6c07c5636ad55130736977149f

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

curl -fsSL --retry 3 -o "$work/inpainting.ckpt" "$ckpt"
echo "$sha  $work/inpainting.ckpt" | shasum -a 256 -c - >/dev/null
# The module subclasses the project's LaMa wrapper only to be loaded by it; the
# network itself needs nothing from it.
curl -fsSL --retry 3 "$repo/manga_translator/inpainting/inpainting_aot.py" \
  | sed 's/^from .inpainting_lama_mpe import LamaMPEInpainter/LamaMPEInpainter = object/' \
  > "$work/aot.py"

cat > "$work/export.py" <<'EOF'
import sys, torch, aot
net = aot.AOTGenerator()
state = torch.load('inpainting.ckpt', map_location='cpu')
net.load_state_dict(state.get('model', state))
net.eval()
size = (1, 3, 256, 256)
torch.onnx.export(net, (torch.zeros(size), torch.zeros(1, 1, *size[2:])), sys.argv[1],
  input_names=['image', 'mask'], output_names=['output'],
  dynamic_axes={k: {2: 'h', 3: 'w'} for k in ('image', 'mask', 'output')},
  opset_version=17, dynamo=False)
EOF
(cd "$work" && uv run --quiet --with torch --with onnx python export.py "$out/aot-inpaint.onnx" 2>/dev/null)

ls -la "$out/aot-inpaint.onnx" | awk '{printf "  %8.1f KB  %s\n", $5/1024, $9}'
