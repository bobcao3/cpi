#!/usr/bin/env bash
# Verify B3 fix (true orphan detach): a backgrounded forever-daemon that the
# agent sh_detach'es must NOT keep `pi --print` alive. Expect: pi exits cleanly
# (exit 0, agent_end present) AND the daemon survives (port still served).
set -uo pipefail
R=/home/chengcao/cpi/repro_test
mkdir -p "$R"
PI="pi --print --mode json --no-session --provider meshy-sglang-kimi --model moonshotai/Kimi-K2.7-Code --thinking off"
PORT=18098
pkill -f "http.server $PORT" 2>/dev/null; sleep 0.3

cat > "$R/b3fix.instr" <<EOF
Follow these steps EXACTLY, in order:
1. Call the sh tool with command: python3 -m http.server $PORT  and set waitfor to 1. (Do NOT add & or nohup; let the sh tool background it.) It will return a "running PID".
2. Call the sh_detach tool, passing that running PID as the id, to release it to run untracked.
3. Reply with exactly this text and then stop: DONE: server detached, stopping now. Do NOT call wait_any. Do NOT kill the server.
EOF

out="$R/b3fix.jsonl"; err="$R/b3fix.err"
start=$(date +%s)
timeout 90 bash -c "$PI" < "$R/b3fix.instr" > "$out" 2>"$err"; code=$?
end=$(date +%s); wall=$((end-start))
echo "exit=$code wall=${wall}s (timeout=90)"

echo "  sh_detach called:        $(rg -c '"name":"sh_detach"' "$out" 2>/dev/null || echo 0)"
echo "  running-PID bgd:         $(rg -c 'running PID=' "$out" 2>/dev/null || echo 0)"
echo "  agent_end present:       $(rg -c '"type":"agent_end"' "$out" 2>/dev/null || echo 0)"
echo "  DONE marker:             $(rg -c 'server detached, stopping now' "$out" 2>/dev/null || echo 0)"

# the daemon must SURVIVE pi's exit
sleep 1
if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null | rg -q '200|301|302'; then
  daemon="ALIVE (serving)"
else
  daemon="DEAD"
fi
echo "  daemon after pi exit:    $daemon"

echo "===== VERDICT ====="
if [ "$code" = "0" ] && rg -q '"type":"agent_end"' "$out" && [ "$daemon" != "DEAD" ]; then
  echo "B3 FIX CONFIRMED: pi exited cleanly ($wall s) with agent_end, daemon survived."
elif [ "$code" = "124" ]; then
  echo "B3 NOT FIXED: pi --print hung (timeout) — orphan did not release the event loop."
else
  echo "INCONCLUSIVE: exit=$code agent_end=$(rg -c '"type":"agent_end"' "$out" 2>/dev/null || echo 0) daemon=$daemon"
fi

echo "===== err tail ====="; tail -5 "$err" 2>/dev/null
pkill -f "http.server $PORT" 2>/dev/null
