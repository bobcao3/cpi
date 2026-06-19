---
name: subagents-in-pi
description: "Use when delegating to a sub-agent, fanning out parallel or background tasks, spawning or resuming a child `pi` agent, or running subagent.sh. Search terms — subagent, delegate, parallel, background pi, --session-id, resume."
---

# Subagents in pi

A subagent is another `pi` process launched through the `sh` tool with the
`subagent.sh` helper. Run it via `sh`; if it outlives `waitfor` it backgrounds,
and `sh` returns its PID + a logfile and fires a completion follow-up on exit.
There is **no separate transcript file**: `pi` print-mode stdout is the clean
final answer, while the helper streams the live markdown transcript to stderr
(the `sh` background log) and prints the raw session `jsonl` path at start and
end, with a run summary (time, turns, input/output tokens) at the very end of
stdout.

## Launch / resume

ALWAYS pass the task via a **quoted heredoc** (`<<'TASK'`) on stdin, never as a
quoted argument. A prompt with backticks, `$`, globs, or quotes gets executed /
word-split / "Argument list too long" if passed as an arg; the quoted heredoc
keeps every character literal — no escaping needed.

```
.pi/skills/subagents-in-pi/subagent.sh -s sub-<slug> <<'TASK'
<task, with full context — `backticks`, $vars, globs, quotes all stay literal>
TASK
```

- `-s <session-id>`: pick a slug to enable resume; **re-run with the same `-s`**
  to continue (pi restores prior context). Omit to auto-generate, then read the
  id back from the `jsonl:` line (the jsonl filename contains the session id).
  Sessions are nested under the parent's session dir in
  `subagents_<PI_SESSION>/` (set by the cpi shell tool via `PI_SESSION` +
  `PI_SESSION_DIR`), so they stay out of the parent's `/resume`. To **resume a
  subagent manually** (outside the parent's `sh` env), pass its session dir
  derived from the `jsonl:` path:
  `pi --session-dir "$(dirname <jsonl-path>)" --session-id <id> -c`.
- `-p <provider>`: default `meshy-sglang-kimi`; pass to match your own.
- Injects `output-protocol.md` (keeps the subagent terse, full answer in its
  final message). Force background now with `sh` `waitfor=1`. Fan out via several
  `sh` launches; collect each result.

<VERY_IMPORTANT>
The subagent is like any other backgrounded shell command:
**DO NOT busy poll its status**,
just wait for the shell completion notification.
</VERY_IMPORTANT>

## Read the result

The `sh` result — inline if it finished within `waitfor`, else the background
log `/tmp/pi-sh-output-<PID>.log` (`<PID>` = the id `sh` / the completion notice
gave) — merges stdout + stderr:

- **stderr, live during the run:** a `jsonl: <path>` line at the start, then the
  streaming markdown transcript (one block per message; tool calls render as
  ```bash or ```xml). `tail -f` the log while a backgrounded subagent works.
- **stdout, at the end:** the clean final answer, then a `jsonl: <path>` line and
  a `summary: time=<s> turns=<n> in=<tok> out=<tok>` line.

The `jsonl` path is pi's native raw session log (full-fidelity, structured) —
read it for deep inspection. `rm` stale logs when finished.

```
grep '^jsonl:' /tmp/pi-sh-output-<PID>.log   # raw session log path
tail -n3 /tmp/pi-sh-output-<PID>.log          # answer tail + summary
```

## Boundaries

Subagents inherit this repo's `.pi` config (they get `sh` + these skills) — keep
nesting one level deep. This is only spawn mechanics; for what to delegate and
stage sequencing, use the QRSPI orchestration skill.
