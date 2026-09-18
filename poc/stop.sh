#!/usr/bin/env bash
# Stops everything start.sh started. Models stay in the HuggingFace cache.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OCR_PORT="${OCR_PORT:-8090}"
MT_PORT="${MT_PORT:-8091}"

for port in "$OCR_PORT" "$MT_PORT"; do
  pkill -f "llama-server.*--port $port" 2>/dev/null && echo "  stopped :$port"
done
pkill -f "python server.py" 2>/dev/null && echo "  stopped the demo"
exit 0
