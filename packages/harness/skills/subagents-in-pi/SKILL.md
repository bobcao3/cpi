---
name: subagents-in-pi
description:
  "Use when delegating to a sub-agent, fanning out parallel or background tasks,
  spawning or resuming a child `pi` agent, or running the `subagent` script.
  Search terms — subagent, delegate, parallel, background pi, --session-id,
  resume."
---

# Subagents in pi

Launch `subagent` directly through `sh`. Use `subagent --help` for the current
flags and output contract.

## Launch and resume

On POSIX, always pass the task on standard input through a **quoted heredoc**;
never pass prompts as positional arguments:

```sh
subagent -s sub-task <<'TASK'
<task, with full context>
TASK
```

The quoted delimiter prevents shell expansion of task text. In native
PowerShell, pipe a literal here-string to `subagent` instead.

Never redirect or pipe the launcher's stdout or stderr: doing so can hide live
observability. Give `sh` a short `waitfor`; if the command backgrounds, wait for
the completion notification rather than polling its log.

Subagents are tracked work, not daemons. Never use `sh_detach`, `setsid`,
`nohup`, or `disown`. Reuse a deliberately chosen session id to resume. Keep
nesting one level deep.

Authoritative launcher behavior is in
[`../../bin/subagent`](../../bin/subagent),
[`../../bin/subagent.js`](../../bin/subagent.js),
[`../../bin/subagent-runner.js`](../../bin/subagent-runner.js), and
[`../../bin/subagent-worker.js`](../../bin/subagent-worker.js).

## Benchmark evidence

From this skill's directory, `scripts/gather-aa-benchmarks.mjs` gathers current
official Artificial Analysis measurements without making recommendations:

```sh
node scripts/gather-aa-benchmarks.mjs
node scripts/gather-aa-benchmarks.mjs <release-slug>
```

The agent remains responsible for Pi-ID mapping, Pareto analysis, and selecting
at most three grounded recommendations.
