# ghostmux

Ghostmux runs terminals without a window. Send input, capture text, or save a
PNG screenshot. It uses Ghostty for terminal state and bundles its fonts. You
can also replay PTY logs after a process exits.

## Start a terminal

From this directory, build with a compatible Zig toolchain. See
[the build manifest](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/build.zig.zon)
for the version requirement. These examples use a POSIX shell.

```sh
zig build --release=safe
ghostmux=./zig-out/bin/ghostmux
mkdir -m 700 ghostmux-demo
socket="$PWD/ghostmux-demo/control.sock"
"$ghostmux" -S "$socket" new-session --uid shell --log ghostmux-demo/shell.pty -- /bin/sh
printf 'echo hello\n' | "$ghostmux" -S "$socket" send-input --uid shell
"$ghostmux" -S "$socket" capture-pane --uid shell --history --join
"$ghostmux" -S "$socket" screenshot --uid shell --output ghostmux-demo/shell.png
```

Use `ghostmux` from PATH instead if it is already installed. Keep the same `-S`
path for every command. Input acknowledgement means the bytes were queued;
repeat the capture if the shell has not produced output yet.

UIDs name sessions, not OS users. Only `new-session` starts a missing daemon,
and live UIDs must be unique. Sessions use the client's directory and
environment, with terminal-specific overrides for POSIX PTYs.

Captures need a live session. After the child exits, Ghostmux briefly collects
output, reports completion, and removes the session. Late output can be lost.
Logs remain available. The daemon exits when no sessions or clients remain.

Resize or stop a session with:

```sh
"$ghostmux" -S "$socket" resize-window --uid shell --cols 100 --rows 30
"$ghostmux" -S "$socket" kill-session --uid shell
```

Forced removal waits for cleanup before replying. It does not promise a final
output drain or the child's actual exit status.

## Keep a short command's output

Subscribe at launch so a fast command cannot finish before you connect:

```sh
"$ghostmux" -S "$socket" new-session --uid job --subscribe --json \
  --log ghostmux-demo/job.pty --status-path ghostmux-demo/job.json \
  -- /bin/sh -c 'printf hello; exit 7'
```

The `subscribed` reply comes before output and completion. Read
`session.exit_code` in the JSON `exit` event or the saved status file. The CLI's
exit status reports its own success, not the child's. Without `--json`, a
subscription writes raw output only. Choose new log and status paths; exceeding
the log size limit fails the session.

Add `--is-pty false` when the child must see pipes instead of a terminal. Stdin
gets EOF, and stdout and stderr share one pipe. Reads, logs, and signals still
work. Input, resizing, text captures, and screenshots fail with `NotPty`.

To observe several sessions, run `subscribe-output --json` without a UID. It
needs an existing daemon. Wait for `subscribed` before launching commands. Keep
a shell session alive while setting it up.

## Replay a log

```sh
"$ghostmux" --input ghostmux-demo/shell.pty --text capture.txt --png capture.png
cat ghostmux-demo/shell.pty | "$ghostmux" --history --join
```

Replay waits for EOF. It interprets recorded terminal bytes but cannot answer
the original program's terminal queries. `--history` includes scrollback;
`--join` joins soft wraps. Screenshots show the viewport only.

## If something fails

For `UnknownUid`, check whether the session has ended. Use logs or subscribe at
launch for short commands. For `NotPty`, check the session's `is_pty` field.

For connection failures, check the socket path and use a private directory you
own. Do not delete lock files to force startup. For missing npm binaries,
reinstall with optional dependencies enabled or build the checkout.

## Further reading

- [Streaming and socket protocols](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/protocol.md)
  covers live captures, byte encoding, signals, and rendering limits.
- [Development and releases](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/development.md)
  covers binary verification, package APIs, and the existing checks.
- [License notices](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/licenses/NOTICE.md)
  explain the Font Logos license and what to check before redistribution.
