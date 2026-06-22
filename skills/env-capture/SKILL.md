---
name: env-capture
description: "Use when snapshotting the current shell environment (e.g. after sourcing a venv or exporting vars) into a session-scoped dotenv file to reload via `env=<path>` on sh / sh_repeat_until / lsp. Search terms — env capture, dotenv, venv env, source activate, env snapshot, PI_SESSION_DIR."
---

# env-capture

`env-capture` snapshots the *current* shell env into a session-scoped dotenv
file, then reloadable via `env=<path>` on `sh` / `sh_repeat_until` / `lsp`.

It is a **script you chain at the end of a `sh` command**, not a separate tool.
Because `sh` runs the whole command in one `bash -c`, the script inherits the
exact env the preceding command produced — no second spawn, no re-execution.
This is the correct way to capture env after `source`/`export` (a plain `sh`
call is stateless, so activation is otherwise lost).

## Usage

```
source .venv/bin/activate && env-capture [label]
```

- `env-capture` is on the `sh` PATH (cpi prepends `bin/`); call it by bare
  name — no path needed. Sub-agents inherit it too.
- `[label]` (or `-l <label>`): optional filename for the dotenv
  (`<label>.env`, sanitized). Omit → `env-<ts>-<pid>.env`.
- Env contents are written to a file and referenced by path; they are **never
  echoed** into the conversation, so no redaction is needed.

## Read the result

stdout (inline if the `sh` call finishes within `waitfor`, else the background
log) is exactly two lines:

```
Captured N env var(s) → /abs/path/to/captures/<name>.env
Reload via: env=/abs/path/to/captures/<name>.env
```

Copy the `env=<path>` snippet and pass it to later `sh` / `sh_repeat_until` /
`lsp start` calls. The path is absolute and session-scoped
(`<sessionDir>/env-captures/`, or `~/.pi/agent/env-captures/` for `--no-session`
parents), so it is reusable across commands in the same session.

## Reload

```
sh:           echo $VIRTUAL_ENV   # env=<path> arg on the sh tool
lsp:          lsp start file=src/main.ts env=<path>
sh_repeat_until: poller inherits the same dotenv via its env= arg
```

## Limits

4096 keys · 32 KiB per value (write side, matching `lib/dotenv.ts` read side).
Values with embedded newlines are an inherent limitation of line-based dotenv
(the read parser skips continuation lines with no valid `KEY=`). A non-zero
exit means nothing was written — inspect the preceding command via `sh`.

## Boundaries

This is capture mechanics only. The read side (`env=` on `sh` /
`sh_repeat_until` / `lsp`) is owned by `extensions/shell/tools.ts`
(`buildShellEnvWithDotenv` → `parseDotEnv`); `bin/env-capture` is its sole writer.
