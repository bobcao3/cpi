const std = @import("std");

pub const Options = struct {
    cols: u16 = 80,
    rows: u16 = 24,
    font_size: u16 = 18,
    scrollback_bytes: usize = 16 * 1024 * 1024,
    input: []const u8 = "-",
    text: ?[]const u8 = null,
    png: ?[]const u8 = null,
    history: bool = false,
    join: bool = false,
    protocol: bool = false,
    help: bool = false,
};

pub fn geometry(cols: u16, rows: u16) !void {
    if (cols == 0 or cols > 500 or rows == 0 or rows > 300) return error.InvalidGeometry;
}

pub fn fontSize(size: u16) !void {
    if (size < 6 or size > 96) return error.InvalidFontSize;
}

pub fn parse(args: []const [:0]const u8) !Options {
    var options: Options = .{};
    var index: usize = 1;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            options.help = true;
            continue;
        }
        const switches = .{ "history", "join", "protocol" };
        var matched = false;
        inline for (switches) |name| {
            if (std.mem.eql(u8, arg, "--" ++ name)) {
                @field(options, name) = true;
                matched = true;
            }
        }
        if (matched) continue;
        if (index + 1 >= args.len) return error.MissingOptionValue;
        index += 1;
        const value = args[index];
        inline for (.{ "cols", "rows", "font-size", "scrollback-bytes", "input", "text", "png" }, .{ "cols", "rows", "font_size", "scrollback_bytes", "input", "text", "png" }) |name, field| {
            if (std.mem.eql(u8, arg, "--" ++ name)) {
                const T = @TypeOf(@field(options, field));
                @field(options, field) = if (@typeInfo(T) == .int) try std.fmt.parseInt(T, value, 10) else value;
                matched = true;
            }
        }
        if (!matched) return error.UnknownOption;
    }
    try geometry(options.cols, options.rows);
    try fontSize(options.font_size);
    if (options.scrollback_bytes > 64 * 1024 * 1024) return error.ScrollbackTooLarge;
    if (options.protocol and (options.text != null or options.png != null or options.history or options.join)) return error.ConflictingOptions;
    if (!options.protocol and options.text == null and options.png == null) options.text = "-";
    return options;
}

pub const help =
    \\Usage: terminal-capture [options]
    \\
    \\Consume raw PTY output from stdin and capture the terminal at EOF.
    \\  --input PATH             Read a stream file instead of stdin (-).
    \\  --text PATH              Write plain UTF-8 capture (- for stdout).
    \\  --png PATH               Write a viewport PNG with bundled fonts.
    \\  --cols N --rows N        Set terminal geometry.
    \\  --history                Include retained scrollback in text capture.
    \\  --join                   Join soft-wrapped lines in text capture.
    \\  --font-size N            Set screenshot font size in pixels.
    \\  --scrollback-bytes N     Bound retained scrollback memory.
    \\  --protocol               Consume ordered NDJSON requests on stdin.
    \\  --help                   Show this help.
    \\
    \\Protocol operations: feed (data or base64), resize (cols, rows),
    \\capture (history, join), screenshot (path, optional font_size), quit.
    \\Each request produces one JSON response. See README.md for examples.
    \\
;
