#!/bin/sh
# Renders the store images for one language into images/<lang>/.
# Needs a browser already open in agent-browser (any page will do).
set -e
cd "$(dirname "$0")"
lang=${1:-en}
mkdir -p "images/$lang"
shoot() {
  agent-browser set viewport "$2" "$3" 1 >/dev/null
  agent-browser open "file://$PWD/frames.html?lang=$lang&n=$1#$1" >/dev/null
  sleep 0.6
  agent-browser screenshot "$PWD/images/$lang/$1.png" >/dev/null
}
for f in f1 f2 f3 f4 f5; do shoot "$f" 1280 800; done
shoot tile 440 280
shoot marquee 1400 560
# The store wants 24-bit PNGs, without alpha.
for f in images/"$lang"/*.png; do sips -s format png -s formatOptions default "$f" >/dev/null; done
python3 - "$lang" <<'PY'
import sys, glob
from PIL import Image
for f in glob.glob(f'images/{sys.argv[1]}/*.png'):
    Image.open(f).convert('RGB').save(f)
PY
