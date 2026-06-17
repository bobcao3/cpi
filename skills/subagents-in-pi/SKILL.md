---
name: subagents-in-pi
description: "Use when delegating to a sub-agent, fanning out parallel or background tasks, spawning or resuming a child `pi` agent, or running subagent.sh. Search terms — subagent, delegate, parallel, background pi, --session-id, resume."
---

# Subagents in pi

A subagent is another `pi` process launched through the `sh` tool with the
`subagent.sh` helper. Run it via `sh`; if it outlives `waitfor` it backgrounds,
and `sh` returns its PID + a logfile and fires a completion follow-up on exit. `pi`
print-mode stdout is clean (only the final assistant message), so the helper
prints the **transcript path as line 1**, then that answer. No wrapping tags.

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
  id back from the transcript filename.
- `-p <provider>`: default `meshy-sglang-kimi`; pass to match your own.
- Injects `output-protocol.md` (keeps the subagent terse, full answer in its
  final message). Force background now with `sh` `waitfor=1`. Fan out via several
  `sh` launches; collect each result.

## Read the result

Line 1 is `transcript: <path>`, the rest is the answer — inline in the `sh`
result if it finished within `waitfor`, else from the background log
`/tmp/pi-sh-output-<PID>.log` (`<PID>` = the id `sh` / the completion notice
gave):

```
head -n1 /tmp/pi-sh-output-<PID>.log    # transcript path
tail -n +2 /tmp/pi-sh-output-<PID>.log   # the answer
```

For the subagent's full reasoning, read its transcript — the `transcript: <path>`
from line 1. It's markdown, written live (one block per message), so you can
`tail -f` it while a backgrounded subagent is still working, or `cat` it when
done. `rm` stale logs/transcripts when finished.

## Boundaries

Subagents inherit this repo's `.pi` config (they get `sh` + these skills) — keep
nesting one level deep. This is only spawn mechanics; for what to delegate and
stage sequencing, use the QRSPI orchestration skill.
