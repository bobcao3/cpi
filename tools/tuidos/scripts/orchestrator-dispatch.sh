#!/usr/bin/env bash
# Run one orchestrator tick and fan out root-owned subagents.
# Invoke normally, never detached; root shutdown cancels workers.
set -uo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 2
cd "$SCRIPT_DIR/.." || exit 2

[[ -n "${CPI_SUBAGENT_RPC:-}" ]] || {
  echo "dispatch: CPI_SUBAGENT_RPC is required" >&2
  exit 2
}

PIDS=()
SIDS=()
CARD_IDS=()
STAGES=()

mapfile -t LINES < <(bun run src/orchestrator/tick.ts 2>/dev/null)
if (( ${#LINES[@]} > 16 )); then
  echo "dispatch: tick returned ${#LINES[@]} dispatches; maximum is 16" >&2
  exit 1
fi
for line in "${LINES[@]:-}"; do
  [[ -z "$line" ]] && continue
  sid="${line%%	*}"; rest="${line#*	}"
  cardId="${rest%%	*}"; stage="${rest#*	}"
  [[ -z "$sid" || -z "$cardId" || -z "$stage" ]] && continue
  prompt="$(bun run src/orchestrator/worker-prompt.ts "$stage" "$cardId" 2>/dev/null)"
  [[ -z "$prompt" ]] && { echo "dispatch: empty prompt for $stage $cardId" >&2; continue; }
  subagent -s "$sid" <<<"$prompt" >"/tmp/tuidos-worker-$sid.log" 2>&1 &
  pid=$!
  PIDS+=("$pid")
  SIDS+=("$sid")
  CARD_IDS+=("$cardId")
  STAGES+=("$stage")
  echo "dispatched $stage $cardId -> $sid (pid $pid)"
done

completed=0
failed=0
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    ((completed += 1))
    echo "completed ${STAGES[$i]} ${CARD_IDS[$i]} -> ${SIDS[$i]} (pid ${PIDS[$i]})"
  else
    status=$?
    ((failed += 1))
    echo "failed ${STAGES[$i]} ${CARD_IDS[$i]} -> ${SIDS[$i]} (pid ${PIDS[$i]}, status $status)" >&2
  fi
done
echo "batch summary: dispatched=${#PIDS[@]} completed=$completed failed=$failed"
(( failed == 0 ))
