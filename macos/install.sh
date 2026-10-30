#!/usr/bin/env bash
# Runs the reader and the translator as launchd agents, so the extension has
# something to talk to without a terminal open. A minute after the last request
# they hand their weights back — 4.2 GB between them down to 0.34 GB — and the
# next request waits three to five seconds while they read them off disk again.
# IDLE=-1 buys those seconds back at the price of the memory.
set -euo pipefail

PREFIX="me.wantan.image-translate"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/image-translate"

OCR_MODEL="${OCR_MODEL:-prithivMLmods/HunyuanOCR-1.5-GGUF-Updated:Q8_0}"
MT_MODEL="${MT_MODEL:-tencent/Hy-MT2-1.8B-GGUF:Q6_K}"
OCR_PORT="${OCR_PORT:-8090}"
MT_PORT="${MT_PORT:-8091}"
# Extra llama-server flags for the translator. TranslateGemma will not start
# without --no-jinja.
MT_ARGS="${MT_ARGS:-}"
IDLE="${IDLE:-60}"
CTX="${CTX:-8192}"

uninstall() {
  for role in reader translator; do
    local label="$PREFIX.$role"
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$AGENTS/$label.plist"
    echo "  removed $label"
  done
  echo
  echo "Models are left in ~/.cache/huggingface; delete that to reclaim the disk."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

command -v llama-server >/dev/null || {
  echo "llama-server is not on PATH. brew install llama.cpp" >&2
  exit 1
}
# launchd starts with almost no PATH, so the binary goes in by absolute path.
LLAMA="$(command -v llama-server)"

mkdir -p "$AGENTS" "$LOGS"

write_agent() {
  local role=$1 model=$2 port=$3 extra=${4:-}
  local label="$PREFIX.$role" args="" arg
  for arg in $extra; do args+="<string>$arg</string>"; done
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LLAMA</string>
    <string>-hf</string><string>$model</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$port</string>
    <string>--parallel</string><string>1</string>
    <!-- llama.cpp leaves flash attention off for this model unless asked. On
         the reader it is worth 155 -> 200 tok/s of decode and cuts prefill by
         a third, for byte-identical output. -->
    <string>-fa</string><string>on</string>
    <string>-c</string><string>$CTX</string>
    <string>--sleep-idle-seconds</string><string>$IDLE</string>
    $args
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive, not Adaptive: under Adaptive launchd throttles the process
       enough to cost half the decode rate — 106 vs 155 tok/s on the reader,
       same flags, same build. The throttle also masks the -fa gain entirely. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$HOME</string></dict>
  <key>StandardOutPath</key><string>$LOGS/$role.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$role.log</string>
</dict>
</plist>
PLIST

  # Replacing a running agent: bootout first, or bootstrap refuses it.
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  # bootout can return before launchd has finished unregistering the label.
  if ! launchctl bootstrap "gui/$UID" "$AGENTS/$label.plist" 2>/dev/null; then
    sleep 1
    launchctl bootstrap "gui/$UID" "$AGENTS/$label.plist"
  fi
  echo "  $label on :$port ($model)"
}

echo "==> Installing agents"
write_agent reader "$OCR_MODEL" "$OCR_PORT"
write_agent translator "$MT_MODEL" "$MT_PORT" "$MT_ARGS"

echo
echo "==> Waiting for them to answer (first run downloads the models)"
for spec in "reader:$OCR_PORT" "translator:$MT_PORT"; do
  role=${spec%%:*}; port=${spec##*:}
  for ((i = 0; i < 360; i++)); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
      echo "  $role ready on :$port"
      break
    fi
    launchctl print "gui/$UID/$PREFIX.$role" >/dev/null 2>&1 || {
      echo "  $role is not running — see $LOGS/$role.log" >&2
      exit 1
    }
    sleep 5
  done
done

cat <<NEXT

Done. They start at login, and $IDLE seconds after the last request they drop
from about 4.2 GB between them to about 0.34 GB. Waking costs a few seconds.

  logs       $LOGS/
  stop one   launchctl bootout gui/$UID/$PREFIX.reader
  remove     $0 --uninstall

The "Local" profile translates with the one on :$MT_PORT. The reader on
:$OCR_PORT is HunyuanOCR, for a profile set to read with it.
NEXT
