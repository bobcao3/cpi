# terminal-capture

A headless terminal CLI built with Zig,
[Ghostty main](https://github.com/ghostty-org/ghostty),
[kb](https://github.com/JimmyLefevre/kb), and
[stb](https://github.com/nothings/stb). The CLI consumes bytes from an existing
PTY, maintains terminal state, captures text, and renders PNG screenshots
without a display server or installed fonts.

This module does not launch commands or replace `tools/sh-monitor` yet. The
caller owns the PTY and supplies resize events. The CLI observes output and does
not send terminal query responses back to the PTY.

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

Raw mode captures at EOF. Supply actual PTY bytes: a line feed moves down
without returning to column zero unless the terminal mode enables that behavior.
PTYs normally translate application newlines to carriage-return/line-feed pairs.

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
node --test tools/terminal-capture/integration.test.mjs
```

The suite requires Python for a real PTY and the repository's `sharp` dependency
to independently decode PNG output. Set `TERMINAL_CAPTURE_BIN` to test a
relocated executable.
