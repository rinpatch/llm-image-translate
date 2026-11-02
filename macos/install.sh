#!/usr/bin/env bash
# Runs the translator as a launchd agent, so the extension has something to talk
# to without a terminal open. A minute after the last request it hands its
# weights back — about 2 GB down to 0.12 GB — and the next request waits about
# three seconds while it reads them off disk again. IDLE=-1 buys those seconds
# back at the price of the memory.
set -euo pipefail

LABEL="me.wantan.llm-image-translate.translator"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/llm-image-translate"
MODEL="tencent/Hy-MT2-1.8B-GGUF:Q6_K"
PORT=8091
IDLE="${IDLE:-60}"

command -v llama-server >/dev/null || {
  echo "llama-server is not on PATH. brew install llama.cpp" >&2
  exit 1
}
# launchd starts with almost no PATH, so the binary goes in by absolute path.
LLAMA="$(command -v llama-server)"

mkdir -p "$AGENTS" "$LOGS"

cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LLAMA</string>
    <string>-hf</string><string>$MODEL</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
    <string>--parallel</string><string>1</string>
    <!-- llama.cpp leaves flash attention off unless asked; it is faster for
         byte-identical output. -->
    <string>-fa</string><string>on</string>
    <string>-c</string><string>8192</string>
    <string>--sleep-idle-seconds</string><string>$IDLE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive, not Adaptive: under Adaptive launchd throttles the process
       enough to cost half the decode rate. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$HOME</string></dict>
  <key>StandardOutPath</key><string>$LOGS/translator.log</string>
  <key>StandardErrorPath</key><string>$LOGS/translator.log</string>
</dict>
</plist>
PLIST

# Replacing a running agent: bootout first, or bootstrap refuses it.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
# bootout can return before launchd has finished unregistering the label.
if ! launchctl bootstrap "gui/$UID" "$AGENTS/$LABEL.plist" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "gui/$UID" "$AGENTS/$LABEL.plist"
fi

echo "==> Waiting for the translator to answer (the first run downloads the model)"
for ((i = 0; i < 360; i++)); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    echo "  ready on :$PORT"
    break
  fi
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || {
    echo "  translator is not running — see $LOGS/translator.log" >&2
    exit 1
  }
  sleep 5
done

cat <<NEXT

Done. It starts at login, and $IDLE seconds after the last request it drops to
about 0.12 GB. Waking costs a few seconds.

  logs   $LOGS/translator.log
  stop   launchctl bootout gui/$UID/$LABEL

Point the extension's translator at http://127.0.0.1:$PORT.
NEXT
