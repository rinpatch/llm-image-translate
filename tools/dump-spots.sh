#!/bin/bash
# Records the reader's spots for every page in test/fixtures/pages.
#
# Writes test/fixtures/spots/<page>.json, which test/grouping.test.ts runs the
# real group() over — so grouping can be changed and judged in node, without
# the browser or the models. Re-run it when the reader changes.
#
#     tools/dump-spots.sh [page-name ...]
#     tools/dump-spots.sh --balloons [page-name ...]
#
# --balloons keeps each page's recorded lines and records only the balloon each
# is in, for when the balloon finder changes and the reader has not.
set -euo pipefail
only_balloons=
if [ "${1:-}" = --balloons ]; then only_balloons=1; shift; fi

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/test/fixtures/spots
port=8778
id=khbiipgidcclbakblacconmmpnacljae

cd "$root"
mkdir -p "$out"
npx esbuild tools/dump-spots.ts --bundle --format=iife --global-name=Dump \
  --target=chrome116 --outfile="$out/.bundle.js" --log-level=warning

python3 -m http.server "$port" --directory test/fixtures >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null; rm -f "$out/.bundle.js"; \
  agent-browser close --all >/dev/null 2>&1 || true' EXIT
sleep 1

agent-browser close --all >/dev/null 2>&1 || true
agent-browser --extension "$root/extension" open "chrome-extension://$id/options.html" >/dev/null

# Paths are relative to test/fixtures, so the heavy manga page — which lives
# beside pages/ rather than in it — can be dumped too.
pages=("$@")
if [ ${#pages[@]} -eq 0 ]; then
  for page in test/fixtures/pages/*.png; do pages+=("pages/$(basename "$page" .png)"); done
fi

for path in "${pages[@]}"; do
  name=$(basename "$path")
  printf '%-20s ' "$name"
  if [ -n "$only_balloons" ]; then
    lines=$(python3 -c "import json; print(json.dumps(json.load(open('$out/$name.json'))['lines']))")
    agent-browser eval "$(cat "$out/.bundle.js"); Dump.balloonsFor(
      'http://127.0.0.1:$port/$path.png', $lines).then(JSON.stringify)" \
      | python3 -c "
import json, sys
owners = json.loads(json.load(sys.stdin))
d = json.load(open('$out/$name.json')); d['balloons'] = owners
open('$out/$name.json', 'w').write(json.dumps(d, ensure_ascii=False, indent=1) + '\n')"
  else
    agent-browser eval "$(cat "$out/.bundle.js"); Dump.dump(
      'http://127.0.0.1:$port/$path.png').then(JSON.stringify)" \
      | python3 -c "import json,sys; print(json.dumps(json.loads(json.load(sys.stdin)), ensure_ascii=False, indent=1))" \
      > "$out/$name.json"
  fi
  python3 -c "
import json; d = json.load(open('$out/$name.json'))
print(len(d['lines']), 'lines,', len(d['divided']), 'divided pairs')"
done

echo "-> $out"
