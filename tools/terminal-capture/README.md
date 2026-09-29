# terminal-capture

A headless terminal CLI built with Zig,
[Ghostty main](https://github.com/ghostty-org/ghostty),
[kb](https://github.com/JimmyLefevre/kb), and
[stb](https://github.com/nothings/stb). The CLI consumes bytes from an existing
PTY, maintains terminal state, captures text, and renders PNG screenshots
without a display server or installed fonts.

The CLI supports managed PTYs as well as playback from an existing PTY stream.
It does not replace `tools/sh-monitor` or integrate with the shell extension.

## Build and run

From this directory:

```sh
zig build --release=safe
./zig-out/bin/terminal-capture --help
./zig-out/bin/terminal-capture --input session.pty --text capture.txt --png capture.png
cat session.pty | ./zig-out/bin/terminal-capture --history --join
```

Use the Zig version specified by `build.zig.zon`. Zig fetches pinned source
dependencies during the build. Update dependency pins with
`zig fetch --save=<name> <url>`; do not hand-edit the manifest. The installed
executable embeds the font assets and can run outside the checkout.

## Managed terminals (Linux)

The Linux server manages PTYs and their child processes. For example:

```sh
./zig-out/bin/terminal-capture new-session --uid build -- /bin/sh -c 'printf "ready\n"'
./zig-out/bin/terminal-capture capture-pane --uid build --history --join
./zig-out/bin/terminal-capture screenshot --uid build --output build.png
./zig-out/bin/terminal-capture list-sessions --json
```

For an interactive session, start one with `new-session --uid interactive`, then
send input and resize it:

```sh
printf 'echo hello\n' | ./zig-out/bin/terminal-capture send-input --uid interactive
./zig-out/bin/terminal-capture resize-window --uid interactive --cols 100 --rows 30
./zig-out/bin/terminal-capture kill-session --uid interactive
./zig-out/bin/terminal-capture kill-server
```

Here `--uid` is an application identifier scoped by the OS user and socket, not
an OS user ID. Only `new-session` starts a missing server. The server rejects
duplicate UIDs and retains completed terminals until `kill-session` removes
them. The server exits when no sessions or clients remain. Use `-S PATH` to
select another socket inside a private directory. New sessions use the calling
client's working directory and environment, not those of the daemon starter.

`send-input` acknowledges queue acceptance, not application processing. Use
`--json` to see session status and, after PTY output drains, the eventual
`exit_code`. See [`src/client.zig`](src/client.zig) for command syntax and
[`src/wire.zig`](src/wire.zig), [`src/transport.zig`](src/transport.zig), and
[`src/app_spawn.zig`](src/app_spawn.zig) for limits and socket policy.

Startup follows the connect/lock/retry sequence in tmux 3.7c's
[client](https://github.com/tmux/tmux/blob/e476c1230b958df0cb12977517d24b3dc931375b/client.c)
and
[server](https://github.com/tmux/tmux/blob/e476c1230b958df0cb12977517d24b3dc931375b/server.c)
implementations. The CLI passes its first connection through a socketpair and
executes the same binary as a detached server. The lock file remains on disk to
preserve one inode for competing startup attempts. The protocol is not
wire-compatible with tmux.

Screenshots are currently synchronous and briefly pause PTY draining. The server
does not keep durable raw logs or provide process-tree containment. Use a
separate supervisor for workloads that escape the managed process groups.

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

Start `terminal-capture --protocol` and keep stdin open. Send newline-delimited
JSON requests. The CLI processes requests in order and flushes one JSON response
per request, so a capture or screenshot observes all preceding feeds. The caller
can continue feeding after a screenshot.

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

After building, run the real-process integration suite from the repository root:

```sh
node --test tools/terminal-capture/*.test.mjs
```

The suite requires Python for a real PTY and the repository's `sharp` dependency
to independently decode PNG output. Set `TERMINAL_CAPTURE_BIN` to test a
relocated executable.
