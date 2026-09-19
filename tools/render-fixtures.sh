#!/bin/bash
# Renders every page in test/fixtures/pages through the real extension.
#
# Writes a PNG and the block list per page, so a change to grouping, skew or
# layout can be diffed against the run before it rather than argued about.
# Needs the models up — see CLAUDE.md — and takes about a minute.
#
#     tools/render-fixtures.sh [out-dir] [target-language]
#
# The extension IDs its cached results by URL, and the profile goes with the
# browser at the end, so every run starts cold.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/.renders}
target=${2:-English}
port=8777
id=khbiipgidcclbakblacconmmpnacljae

cd "$root"
mkdir -p "$out"
npm run build >/dev/null

python3 -m http.server "$port" --directory test/fixtures/pages >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null; \
  agent-browser close --all >/dev/null 2>&1 || true' EXIT
sleep 1

agent-browser close --all >/dev/null 2>&1 || true
agent-browser --extension "$root/extension" open "chrome-extension://$id/options.html" >/dev/null
agent-browser eval "chrome.storage.sync.set({target:'$target'}).then(()=>'ok')" >/dev/null

for page in test/fixtures/pages/*.png; do
  name=$(basename "$page" .png)
  printf '%-20s ' "$name"
  # Shown at natural size: the screenshot is then the render, not a resampling.
  agent-browser eval "
    chrome.runtime.sendMessage({type:'translateImage',jobId:'$name',
      src:'http://127.0.0.1:$port/$name.png'}).then(r => {
      if (!r.ok) return 'FAILED ' + r.code + ' ' + r.error;
      document.body.style.margin = '0';
      document.body.innerHTML = '<img style=\"display:block\" src=\"' + r.image + '\">';
      return r.blocks.length + ' blocks | ' + r.blocks.map(b => b.src).join(' | ');
    })" | tee "$out/$name.txt"
  sleep 1
  agent-browser screenshot "$out/$name.png" >/dev/null
done

echo "-> $out"
