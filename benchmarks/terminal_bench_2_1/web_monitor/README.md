# TB2.1 Web Monitor

Simple Bun server to watch a TerminalBench 2.1 harbor run live:
overall stats + per-trial results table + rendered transcript tail of
`agent/pi.txt` (pi `--mode json` JSONL) + `job.log` tail.

No asciinema — the cpi harness pipes `pi -> pi.txt` (no tty cast).

## Run

```bash
cd benchmarks/terminal_bench_2_1/web_monitor
bun run server.ts            # default jobs=../jobs port=8787
bun run server.ts --jobs ../jobs --port 8787
```

Open http://localhost:8787

## What you see

- **Header**: job selector, live stats (done/pass/fail/run/pend/err,
  tokens, mean reward), auto-refresh toggle.
- **Left**: trial table — task, status badge, reward, tokens in/out,
  duration. Click a row.
- **Right tabs**:
  - **Transcript** — rendered pi.txt events: user instruction, assistant
    text + collapsed thinking, tool calls (`sh`) with command + result
    + exit code, turn separators. Live tail (polls every 2s).
  - **Verifier** — `reward.txt` + `test-stdout.txt`.
  - **Job Log** — `job.log` tail.

## Endpoints

- `GET /api/jobs`
- `GET /api/job/:job/result`
- `GET /api/job/:job/trials`
- `GET /api/job/:job/log?after=N`
- `GET /api/job/:job/trial/:trial/transcript?after=N`
- `GET /api/job/:job/trial/:trial/verifier`
