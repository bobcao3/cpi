---
name: subagents-in-cpi
description:
  Completing tasks when user explicitly requests subagents or 'fan-out', or when
  researching multiple disjoint topics or files
---

# Subagents are shell commands

Launch `subagent` directly through `sh`. Use `subagent --help` for the current
flags and output contract.

## Launch and resume

Subagents are shell invocations of the `cpi` harness through the `subagent`
entrypoint. Avoid directly invoking `cpi` CLI.

Use `subagent --help` for current flags and output contract.

```sh
subagent -s sub-task <<'TASK'
<task, with full context>
TASK
```

Never redirect or pipe the launcher's stdout or stderr: doing so can hide live
observability. Give `sh` a 0s `waitfor` to immediately background.

Wait for the shell completion notification rather than polling its log.

Subagents are tracked by the parent agent harness, do not invoke `sh_detach`,
`setsid`, `nohup`, or `disown`. You can interrupt it at any time by interrupting
the process.

Reuse a deliberately chosen session id to resume an agent.

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
