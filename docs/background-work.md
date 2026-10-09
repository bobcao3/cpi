# Background work

`sh` runs a command and waits up to its `waitfor` (default 5 s). If the command
is still running, cpi backgrounds it and returns a running id, the log path, and
a bounded output preview, then wakes the agent when the command completes. The
defaults and hard limits are configuration, not documentation: see the `shell`
section of
[`cpi-config.default.json`](../packages/harness/cpi-config.default.json).

Each background shell is a session in the
[Ghostmux daemon](../packages/ghostmux/README.md). Its exit status, drained
output, and log file survive agent turns; completion wakes the agent with a
notification carrying the exit code and a log line range. What the agent is
told is the authority in
[`shell.toml`](../packages/harness/src/text/shell.toml).

- **Signals.** `sh_signal` targets the whole process group. SIGKILL suppresses
  the completion notice; other signals do not guarantee termination and still
  report completion when the process exits.
- **Detach.** `sh_detach` releases a running shell: the process continues
  untracked, loses signalling and completion notices, and disappears from the
  background list. Use it only for processes that must outlive the session.
- **Restart and reload.** A reload keeps tracked shells; a new session resumes
  them from persisted records. Shells that cannot be reattached are reported as
  orphaned or lost, never as completed.
- **Shutdown.** Session shutdown stops tracking running shells and requests
  termination. The final exit status is unknown afterwards; check the log and
  side effects before restarting.

Repeat monitors (`sh_repeat_until`) are not background shells: they re-run a
command every 5–60 s, stop on the first non-zero exit, and breach when one
invocation outlasts its interval. Cancel them with `sh_signal` on their `rpt-`
id.

Inspect current work with `sh_background_ps`, the footer counters, or the
[activity browser](activity-browser.md).
