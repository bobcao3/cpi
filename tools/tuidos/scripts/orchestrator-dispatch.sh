#!/usr/bin/env bash
# One orchestrator tick: claim+list dispatches (tick.ts), then spawn a detached
# subagent per line. All pipeline state lives in clidos (card column = stage;
# thread claim = in-flight) — there is NO external tracking file. The continual
# monitor (sh_repeat_until) runs this every interval; it always exits 0 so the
# monitor keeps looping. Workers are detached (setsid/nohup) so they survive.
set -uo pipefail
cd /home/bob/cpi/tools/tuidos || exit 0

mapfile -t LINES < <(bun run src/orchestrator/tick.ts 2>/dev/null)
for line in "${LINES[@]:-}"; do
  [[ -z "$line" ]] && continue
  sid="${line%%	*}"; rest="${line#*	}"
  cardId="${rest%%	*}"; stage="${rest#*	}"
  [[ -z "$sid" || -z "$cardId" || -z "$stage" ]] && continue
  prompt="$(bun run src/orchestrator/worker-prompt.ts "$stage" "$cardId" 2>/dev/null)"
  [[ -z "$prompt" ]] && { echo "dispatch: empty prompt for $stage $cardId" >&2; continue; }
  if command -v setsid >/dev/null 2>&1; then SET="setsid"; else SET="nohup"; fi
  $SET subagent -s "$sid" <<<"$prompt" >"/tmp/tuidos-worker-$sid.log" 2>&1 &
  disown 2>/dev/null || true
  echo "dispatched $stage $cardId -> $sid"
done
echo "tick done"
exit 0
