---
name: env-capture
description:
  "Use when snapshotting the current shell environment (e.g. after sourcing a
  venv or exporting vars) into a session-scoped dotenv file to reload via
  `env=<path>` on sh / sh_repeat_until / lsp. Search terms — env capture,
  dotenv, venv env, source activate, env snapshot, PI_SESSION_DIR."
---

# env-capture

`env-capture` snapshots the current shell environment into a session-scoped
dotenv file.

Chain it at the end of the same `sh` command after activation or export:

```
source .venv/bin/activate && env-capture
```

`sh` runs the command in one invocation of the resolved shell, so `env-capture`
sees the environment produced by the preceding command. Separate `sh` calls are
stateless. Call `env-capture` by its bare name.

Copy the printed `env=<path>` into later `sh`, `sh_repeat_until`, or `lsp`
calls. Environment contents remain in the file.

The authoritative CLI and implementation are
[`../../bin/env-capture`](../../bin/env-capture). The read-side parser is
[`../../extensions/lib/dotenv.ts`](../../extensions/lib/dotenv.ts) and
[`../../extensions/shell/tools.ts`](../../extensions/shell/tools.ts).
