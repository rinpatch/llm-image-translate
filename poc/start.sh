#!/usr/bin/env bash
# Brings up the reader, the translator and the demo, then waits until each
# answers. Safe to re-run: anything already listening is left alone.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OCR_MODEL="${OCR_MODEL:-ggml-org/HunyuanOCR-GGUF}"
MT_MODEL="${MT_MODEL:-bullerwins/translategemma-4b-it-GGUF:Q4_K_M}"
# TranslateGemma is trained on one fixed prompt and its chat template
# refuses a plain string, so the pipeline builds the prompt itself.
MT_STYLE="${MT_STYLE:-gemma}"
MT_ARGS="${MT_ARGS:---no-jinja}"
OCR_PORT="${OCR_PORT:-8090}"
MT_PORT="${MT_PORT:-8091}"
DEMO_PORT="${DEMO_PORT:-8000}"

# One slot, not four. The default splits the context between slots and a
# full-resolution image then overflows its share mid-request.
CTX="${CTX:-8192}"

# Idle models hand their weights back and take about a second to pick them up
# again, which beats holding 3.7 GB for a tool used a few times an hour. -1
# disables it.
IDLE="${IDLE:-300}"
LOGS="${LOGS:-.logs}"

for tool in llama-server uv; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done
mkdir -p "$LOGS"

listening() { curl -fsS -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null; }

serve() {
  local port=$1 name=$2 model=$3
  if listening "$port"; then echo "  $name already up on :$port"; return; fi
  echo "  starting $name ($model)"
  # An empty array under `set -u` is an error on the bash macOS ships, so the
  # extra arguments go in as a plain string that is only expanded when set.
  local extra=""
  [[ "$name" == translator ]] && extra="$MT_ARGS"
  # shellcheck disable=SC2086
  nohup llama-server -hf "$model" --port "$port" --host 127.0.0.1 \
    --parallel 1 -c "$CTX" --sleep-idle-seconds "$IDLE" $extra > "$LOGS/$name.log" 2>&1 &
}

await() {
  local port=$1 name=$2 tries=${3:-180}
  for ((i = 0; i < tries; i++)); do
    listening "$port" && { echo "  $name ready on :$port"; return; }
    sleep 5
  done
  echo "  $name never came up — see $LOGS/$name.log" >&2
  exit 1
}

echo "models (first run downloads them, which takes a while)"
serve "$OCR_PORT" reader "$OCR_MODEL"
serve "$MT_PORT" translator "$MT_MODEL"
await "$OCR_PORT" reader
await "$MT_PORT" translator

pkill -f "poc/server.py|python server.py" 2>/dev/null || true
sleep 1
echo "demo"
OCR_SERVER="http://127.0.0.1:$OCR_PORT" \
MT_SERVER="http://127.0.0.1:$MT_PORT" \
MT_STYLE="$MT_STYLE" \
  nohup uv run python server.py "$DEMO_PORT" > "$LOGS/demo.log" 2>&1 &

for ((i = 0; i < 30; i++)); do
  curl -fsS -o /dev/null "http://127.0.0.1:$DEMO_PORT/" 2>/dev/null && break
  sleep 1
done

echo
echo "  open  http://127.0.0.1:$DEMO_PORT"
echo "  logs  $LOGS/"
