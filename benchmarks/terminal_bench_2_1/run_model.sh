#!/usr/bin/env bash
# Convenience wrapper for running TerminalBench 2.1 with pre-configured model profiles.
#
# Usage:
#   ./run_model.sh kimi       # Kimi K2.7-Code
#   ./run_model.sh glm        # GLM-5.2 with max thinking effort
#   ./run_model.sh kimi --dry-run
#   ./run_model.sh glm --n-concurrent 8
#
# Any extra args after the model name are forwarded to the Python script.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODEL="${1:-}"
shift || true

if [ -z "$MODEL" ]; then
  echo "Usage: $0 <kimi|glm> [extra args...]"
  exit 1
fi

case "$MODEL" in
  kimi)
    exec python3 "$SCRIPT_DIR/run_terminal_bench_2_1.py" \
      --endpoint https://sglang-kimi-k27-code-b200.onca-snapper.ts.net/v1 \
      --model moonshotai/Kimi-K2.7-Code \
      --temperature 1.0 \
      --top-p 0.95 \
      --max-input-tokens 262144 \
      --max-output-tokens 32768 \
      --interleaved-thinking \
      "$@"
    ;;
  glm)
    exec python3 "$SCRIPT_DIR/run_terminal_bench_2_1.py" \
      --endpoint https://sglang-glm52-b200.onca-snapper.ts.net/v1 \
      --model zai-org/GLM-5.2-FP8 \
      --temperature 1.0 \
      --top-p 0.95 \
      --max-input-tokens 409600 \
      --max-output-tokens 131072 \
      --reasoning-effort max \
      --interleaved-thinking \
      --chat-template-kwargs reasoning_effort=max \
      "$@"
    ;;
  *)
    echo "Unknown model: $MODEL (use 'kimi' or 'glm')"
    exit 1
    ;;
esac
