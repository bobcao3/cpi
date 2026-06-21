# TB2.1 Web Monitor

Bun WebSocket monitor for a TerminalBench 2.1 harbor run: overall stats +
per-trial results table + streamed transcript of `agent/pi.txt` (pi
`--mode json` JSONL) + `job.log` tail.

No asciinema — the cpi harness pipes `pi -> pi.txt` (no tty cast).

## Run

```bash
cd benchmarks/terminal_bench_2_1/web_monitor
bun run server.ts            # default jobs=../jobs port=8787
bun run server.ts --jobs <dir> --port <port>
```

Open http://localhost:8787

## Architecture

WebSocket streaming monitor, not polling REST. The server upgrades
`/ws?job=<job>` and watches the job dir with `fs.watch`:

- job dir (debounced 150ms) -> pushes `result` + `trials`
- `agent/pi.txt` (debounced 30ms) -> pushes `transcript` deltas from the
  last read offset

Both are backstopped by 1s safety intervals. Only the **Job Log** tab is
polled by the client (every 2s via `/api/job/:job/log`); transcript and
trials arrive over the socket.

### WebSocket protocol

`WS /ws?job=<job>` (upgrade).

- client -> server: `{"type":"select","trial":"<trial>"}` — resets the
  transcript byte offset to 0, backfills from byte 0, opens the pi.txt
  watcher for that trial.
- server -> client:
  - `{"type":"result","result":...}`
  - `{"type":"trials","trials":[...]}`
  - `{"type":"select","trial":"<trial>"}` — client clears the transcript pane
  - `{"type":"transcript","events":[...],"next":<byte offset>}`

## What you see

- **Header**: job selector, live stats (done/pass/fail/run/pend/err,
  tokens, mean reward, genuine rate), and a `#wsdot` connection-status
  indicator (green live / red dead). No auto-refresh toggle.
- **Left**: trial table — task, overall reward score with a solid
  background picked from a red-to-green gradient by score, tokens,
  duration. Click a task row to expand its sub-trials; sub-trials show
  pass/fail/timeout/endpoint/0tok badges.
- **Right tabs**:
  - **Transcript** — rendered pi.txt events streamed over WS: user
    instruction, assistant text + collapsed thinking, tool calls (`sh`)
    with command + result + exit code, turn separators.
  - **Verifier** — `verifier/reward.txt` + `verifier/test-stdout.txt`.
  - **Job Log** — `job.log` tail (polled every 2s).

## Files

Split across `index.html` (markup), `styles.css` (theme), `app.js` (client).
The server serves all three from its own directory.

## Endpoints

- `GET /` — `index.html`
- `GET /styles.css`
- `GET /app.js`
- `GET /api/jobs`
- `GET /api/job/:job/result`
- `GET /api/job/:job/trials`
- `GET /api/job/:job/log?after=N`
- `GET /api/job/:job/trial/:trial/verifier`
- `WS /ws?job=<job>`
