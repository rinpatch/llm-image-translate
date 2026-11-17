#!/bin/bash
# Builds the extension and zips it twice, into release/:
#
#     <name>-<version>.zip         a folder to unzip and pick with Load unpacked
#     <name>-<version>-store.zip   what the Chrome Web Store takes
#
# The store refuses a manifest with a `key` in it, so that copy goes without.
# The other keeps it: it fixes the extension ID, so someone replacing the folder
# with a newer one keeps their settings and language packs.
#
# The OCR and inpainting weights and ONNX Runtime's wasm go in both. The store forbids running
# downloaded code, so the wasm has to ship, and the weights are small enough
# that fetching them later would only cost the reader working offline.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# Fails on its own if vendor/ocr is missing.
npm run build >/dev/null

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./extension/manifest.json').version")
out=$root/release
stage=$out/$name-$version
rm -rf "$stage" "$stage.zip" "$stage-store.zip"
mkdir -p "$out"

# A build runs without the inpainter, but a release without it would quietly
# paint every block flat.
[ -f extension/vendor/ocr/aot-inpaint.onnx ] || {
  echo "no inpainter in extension/vendor/ocr — run tools/fetch-inpaint-model.sh" >&2; exit 1; }
# Nor the balloon finder, without which manga is set in the reader's columns.
[ -f extension/vendor/ocr/balloons.onnx ] || {
  echo "no balloon finder in extension/vendor/ocr — run tools/fetch-balloon-model.sh" >&2; exit 1; }

# _metadata is Chrome's, written into the folder when it loads it unpacked.
rsync -a --exclude _metadata --exclude .DS_Store extension/ "$stage/"
cp LICENSE THIRD_PARTY_NOTICES.txt "$stage/"

(cd "$out" && zip -qrX "$stage.zip" "$name-$version")

node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const { key, ...manifest } = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$stage/manifest.json"
(cd "$stage" && zip -qrX "$stage-store.zip" .)

rm -rf "$stage"
ls -lh "$stage.zip" "$stage-store.zip" | awk '{print $5, $NF}'
