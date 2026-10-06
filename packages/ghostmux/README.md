# ghostmux

A headless terminal CLI built with Zig,
[Ghostty main](https://github.com/ghostty-org/ghostty),
[kb](https://github.com/JimmyLefevre/kb), and
[stb](https://github.com/nothings/stb). The CLI consumes bytes from an existing
PTY, maintains terminal state, captures text, and renders PNG screenshots
without a display server or installed fonts.

For the shell-tool integration, see
[`monitor.ts`](../extensions/extensions/shell/monitor.ts).

The package API is `@cpi/ghostmux/resolve`; release provenance and verification
are exported through `@cpi/ghostmux/source` and `@cpi/ghostmux/signature`.
`install.test.mjs` installs real packages using npm and Bun through an isolated
registry. Set `GHOSTMUX_TEST_ARTIFACT` to a directory of signed release artifacts
to test native-package resolution, tampering, and version mismatches.

## npm distribution

The source workspace is private; publish only artifacts prepared by
`scripts/package.mjs`. Give it the signed native-artifact directory and a new
output directory. The generated `packages.json` lists native packages before
the wrapper in publication order. The release workflow has an explicit npm
publication input; leaving it disabled produces reviewable tarballs.

Supported targets and CPU requirements live in [platforms.json](platforms.json),
which also drives the native build matrix. Package-manager architecture filters
cannot detect CPU instruction-set support: the baseline in that manifest is a
hardware requirement. Platform packages are generated outside the workspace so
development installs do not try to install foreign-platform workspaces.

For runtime asset selection and development overrides, see
[the resolver](bin/ghostmux-resolve.mjs). Native source changes require rebuilding;
JavaScript source changes apply directly in a linked checkout.

## Build and run

From this directory:

```sh
zig build --release=safe
./zig-out/bin/ghostmux --help
./zig-out/bin/ghostmux --input session.pty --text capture.txt --png capture.png
cat session.pty | ./zig-out/bin/ghostmux --history --join
```

Use the Zig version specified by `build.zig.zon`. Zig fetches pinned source
dependencies during the build. Update dependency pins with
`zig fetch --save=<name> <url>`; do not hand-edit the manifest. The installed
executable embeds the font assets and can run outside the checkout.

## Managed terminals

The server manages PTYs on POSIX systems and ConPTY terminals on Windows. For
example:

```sh
./zig-out/bin/ghostmux new-session --uid build --log build.pty -- /bin/sh
./zig-out/bin/ghostmux capture-pane --uid build --history --join
./zig-out/bin/ghostmux screenshot --uid build --output build.png
./zig-out/bin/ghostmux list-sessions --json
```

For an interactive session, start one with `new-session --uid interactive`, then
send input and resize it:

```sh
printf 'echo hello\n' | ./zig-out/bin/ghostmux send-input --uid interactive
./zig-out/bin/ghostmux resize-window --uid interactive --cols 100 --rows 30
./zig-out/bin/ghostmux kill-session --uid interactive
./zig-out/bin/ghostmux kill-server
```

Here `--uid` is an application identifier scoped by the OS user and socket, not
an OS user ID. Only `new-session` starts a missing server. The server rejects
duplicate live UIDs. When the child exits, the server drains available output,
delivers completion to subscribers, and removes the session. Captures and
screenshots require a live session. The server exits when no sessions or clients
remain. Use `-S PATH` to select another socket inside a private directory. New
sessions use the calling client's working directory and environment, not those
of the daemon starter.

`send-input` acknowledges queue acceptance, not application processing. Output
subscriptions report the final `session.exit_code` after output drains. See
[`src/client.zig`](src/client.zig) for command syntax and
[`src/wire.zig`](src/wire.zig), [`src/transport.zig`](src/transport.zig), and
[`src/managed_process.zig`](src/managed_process.zig) for limits and socket
policy.

Startup follows the connect/lock/retry sequence used by tmux 3.7c's
[client](https://github.com/tmux/tmux/blob/e476c1230b958df0cb12977517d24b3dc931375b/client.c)
and
[server](https://github.com/tmux/tmux/blob/e476c1230b958df0cb12977517d24b3dc931375b/server.c)
implementations. The CLI starts the same binary as a detached server. The lock
file remains on disk to preserve one inode for competing startup attempts. The
protocol is not wire-compatible with tmux.

Screenshots currently hold the selected terminal's state lock while rendering.
The server does not provide process-tree containment. Use a separate supervisor
for workloads that escape the managed process groups.

## Output reads, subscriptions, and logs

For noninteractive commands that need pipe semantics, disable the terminal:

```sh
./zig-out/bin/ghostmux new-session --uid build --is-pty false --subscribe --json -- /bin/sh -c 'printf hello; printf error >&2'
```

Pipe sessions give stdin EOF and merge stdout and stderr into one OS pipe. The
server preserves raw output bytes and the supplied environment without terminal
emulation, terminal-query replies, or terminal environment overrides. Programs
therefore observe non-TTY standard streams. Output reads, subscriptions, logs,
and signals work for both session types. Pipe sessions reject terminal captures,
screenshots, resizing, and input with `NotPty`. Session status exposes `is_pty`.

See [`src/managed_process.zig`](src/managed_process.zig) for backend selection
and [`shell.toml`](../extensions/extensions/text/shell.toml) for
model-facing shell and capture guidance.

Launch short-lived commands with an atomic output subscription:

```sh
./zig-out/bin/ghostmux new-session --uid build --subscribe --json -- /bin/sh -c 'printf hello; exit 7'
```

The server registers the launch subscriber before creating the child. The
`subscribed` acknowledgement includes the session UID and PID, and precedes
output and completion events. Without `--json`, the CLI writes only raw output;
the CLI's own successful exit reports protocol completion, not the child's exit
status. Use the JSON exit event to obtain the child's status.

Alternatively, start a multiplexed subscriber and wait for the `subscribed`
acknowledgement before launching commands:

```sh
./zig-out/bin/ghostmux subscribe-output --json
```

The subscriber requires an existing server and observes current and future
sessions. A subscription with a UID observes only the selected session:

```sh
./zig-out/bin/ghostmux subscribe-output --uid interactive > interactive.pty
./zig-out/bin/ghostmux read-output --uid interactive --offset 0 --limit 4096 --json
```

Use `new-session --log PATH` when output must remain available after the session
ends. Keep a shell session alive while establishing a multiplexed subscription.

Send a signal without waiting for session removal:

```sh
./zig-out/bin/ghostmux signal-session --uid interactive --signal SIGTERM
```

On POSIX, the server signals the child's process group and any distinct terminal
foreground process group. On Windows, signal requests forcibly terminate the
managed job's process tree rather than deliver POSIX signals. Output subscribers
receive completion after the existing child-wait and output-drain paths finish.
`kill-session` instead waits for session removal before acknowledging.

The CLI and protocol are defined in [`src/client.zig`](src/client.zig) and
[`src/wire.zig`](src/wire.zig). See [`src/output.zig`](src/output.zig) for
retained output and log limits, and
[`src/subscription.zig`](src/subscription.zig) and
[`src/channel.zig`](src/channel.zig) for delivery, completion, and slow-client
handling. These raw-output operations differ from formatted terminal captures.

## Existing PTY streams

Raw mode captures at EOF. Supply actual PTY bytes: a line feed moves down
without returning to column zero unless the terminal mode enables that behavior.
PTYs normally translate application newlines to carriage-return/line-feed pairs.
Raw playback observes output and cannot reply to terminal queries; managed
sessions can reply.

Text capture resembles `tmux capture-pane`, but does not implement tmux's
command-line syntax. The capture contains the active screen by default. Use
`--history` for retained scrollback and `--join` to join soft wraps. Ghostty's
formatter removes trailing spaces and blank rows. Raw text output appends a
final newline to nonempty captures; protocol text does not.

## Capture during a stream

Start `ghostmux --protocol` and keep stdin open. Send newline-delimited JSON
requests. The CLI processes requests in order and flushes one JSON response per
request, so a capture or screenshot observes all preceding feeds. The caller can
continue feeding after a screenshot.

```json
{"op":"feed","data":"hello\r\n\u001b[31mred\u001b[0m"}
{"op":"capture"}
{"op":"screenshot","path":"first.png"}
{"op":"resize","cols":100,"rows":30}
{"op":"feed","base64":"5Lit5paHIPCfmIA="}
{"op":"capture","history":true,"join":true}
{"op":"screenshot","path":"second.png","font_size":24}
{"op":"quit"}
```

Use `base64` for arbitrary PTY bytes, including chunks that split a UTF-8
character or escape sequence. Use `data` for a JSON string. Do not supply both.
Successful responses contain `ok`, `cols`, and `rows`; capture responses also
contain `text`, and screenshot responses contain `path`.

The request schema lives in [`src/protocol.zig`](src/protocol.zig). CLI defaults
and geometry limits live in [`src/options.zig`](src/options.zig). Invalid
requests, exceeded limits, and I/O failures terminate the CLI with a nonzero
status and a diagnostic on stderr. Callers must treat EOF without the expected
response as a failed request.

Only a trusted controller should write protocol requests, because screenshot
requests write files. Feed untrusted program output as `data` or `base64`, never
as protocol requests. The renderer accepts only bundled font data; stb is not a
validator for untrusted font files.

## Rendering and verification

See the font manifest and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for
font coverage, provenance, and licenses. Emoji use monochrome outlines because
stb does not render color-font tables. Font coverage is broad rather than
universal. Screenshots render terminal cells, not Kitty or Sixel graphics.

Ligatures depend on the selected font's tables; the bundled Noto Sans Mono faces
do not provide `ffl` ligatures. The renderer synthesizes italic styling. The CJK
sizing reference is Ghostty's
[`Collection.scaleFactor`](https://github.com/ghostty-org/ghostty/blob/12752b2ac1bb05ce53402ed8c853ed1f96eef0b1/src/font/Collection.zig#L593-L664)
and
[`FaceMetrics.icWidth`](https://github.com/ghostty-org/ghostty/blob/12752b2ac1bb05ce53402ed8c853ed1f96eef0b1/src/font/Metrics.zig#L179-L185).

Run the portable native suite from this directory:

```sh
zig build test --release=safe
```

The test programs are compiled directly by [`build.zig`](build.zig). The daemon
fixtures use typed protocol requests and separate child executables; CLI tests
exercise the public launcher.

After building, run additional rendering checks from the repository root:

```sh
node --test packages/ghostmux/integration.test.mjs
```

The rendering checks use `sharp` to independently decode PNG output. The
remaining JavaScript daemon suites require POSIX and Python. Set `GHOSTMUX_BIN`
to test a relocated executable.

See [the shared package build workflow](../../.github/workflows/build-packages.yml)
for the platform matrix and cpi shell, installed-package, and native runtime
integration commands.
