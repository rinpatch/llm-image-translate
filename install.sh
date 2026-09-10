#!/bin/bash
set -euo pipefail

HOST_NAME="me.wantan.translate"
EXTENSION_ID="khbiipgidcclbakblacconmmpnacljae"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/InPlaceTranslate"

# The extension ID is pinned by the "key" field in extension/manifest.json, so a
# manifest written now keeps working across reloads and reinstalls. Extra IDs can
# be passed as arguments if you repack the extension under a different key.
ALLOWED=("chrome-extension://$EXTENSION_ID/")
for extra in "$@"; do ALLOWED+=("chrome-extension://$extra/"); done

echo "==> Building the native host"
swift build --package-path "$ROOT/native" -c release

mkdir -p "$INSTALL_DIR"
install -m 755 "$ROOT/native/.build/release/translator-host" "$INSTALL_DIR/translator-host"
echo "==> Installed $INSTALL_DIR/translator-host"

origins=$(printf '"%s",' "${ALLOWED[@]}")
manifest=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "On-device translation bridge for macOS",
  "path": "$INSTALL_DIR/translator-host",
  "type": "stdio",
  "allowed_origins": [${origins%,}]
}
JSON
)

BROWSER_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Google/Chrome Beta"
  "$HOME/Library/Application Support/Google/Chrome Canary"
  "$HOME/Library/Application Support/Chromium"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "$HOME/Library/Application Support/Microsoft Edge"
  "$HOME/Library/Application Support/Vivaldi"
  "$HOME/Library/Application Support/Arc/User Data"
)

installed=0
for dir in "${BROWSER_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$manifest" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
  echo "==> Registered host in ${dir##*/Application Support/}"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "!! No Chromium-based browser profile found. Nothing was registered." >&2
  exit 1
fi

cat <<NEXT

Done. Now:
  1. Open chrome://extensions, turn on Developer mode.
  2. "Load unpacked" and pick: $ROOT/extension
     It must load with ID $EXTENSION_ID — that is what the host manifest allows.
  3. Restart the browser so it picks up the native messaging host.
  4. Add your language pairs in System Settings > General > Language & Region >
     Translation Languages. Nothing translates until a pair is downloaded.
NEXT
