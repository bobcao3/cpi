const std = @import("std");
const wire = @import("wire.zig");
const options = @import("options.zig");
const transport = @import("transport.zig");
const Channel = @import("channel.zig");

pub fn is_command(args: []const [:0]const u8) bool {
    return args.len > 1 and (!std.mem.startsWith(u8, args[1], "-") or std.mem.eql(u8, args[1], "-S"));
}

fn operation(name: []const u8) !wire.Operation {
    inline for (.{ "new-session", "list-sessions", "capture-pane", "screenshot", "send-input", "resize-window", "kill-session", "kill-server", "read-output", "subscribe-output", "signal-session" }, .{ .new_session, .list_sessions, .capture_pane, .screenshot, .send_input, .resize_window, .kill_session, .kill_server, .read_output, .subscribe_output, .signal_session }) |text, op| {
        if (std.mem.eql(u8, name, text)) return op;
    }
    return error.UnknownCommand;
}

pub fn run(init: std.process.Init, args: []const [:0]const u8) !void {
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try std.process.currentPathAlloc(init.io, allocator);
    var index: usize = 1;
    var explicit_socket: ?[]const u8 = null;
    if (std.mem.eql(u8, args[index], "-S")) {
        if (args.len <= index + 2) return error.MissingCommand;
        explicit_socket = try std.fs.path.resolve(allocator, &.{ cwd, args[index + 1] });
        index += 2;
    }
    var request: wire.Request = .{ .op = try operation(args[index]) };
    var json = false;
    var input: ?[]const u8 = null;
    var dimensions: u2 = 0;
    index += 1;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--")) {
            if (request.op != .new_session or index + 1 == args.len) return error.UnexpectedArguments;
            const command = try allocator.alloc([]const u8, args.len - index - 1);
            for (args[index + 1 ..], command) |item, *target| target.* = item;
            request.argv = command;
            break;
        }
        if (std.mem.eql(u8, arg, "--json")) {
            json = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--subscribe")) {
            if (request.op != .new_session) return error.UnexpectedOption;
            request.subscribe = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--history") or std.mem.eql(u8, arg, "--join")) {
            if (request.op != .capture_pane) return error.UnexpectedOption;
            if (std.mem.eql(u8, arg, "--history")) request.history = true else request.join = true;
            continue;
        }
        if (index + 1 == args.len) return error.MissingOptionValue;
        index += 1;
        const value = args[index];
        if (std.mem.eql(u8, arg, "--uid")) {
            request.uid = value;
        } else if (std.mem.eql(u8, arg, "--is-pty")) {
            if (request.op != .new_session) return error.UnexpectedOption;
            request.is_pty = if (std.mem.eql(u8, value, "true")) true else if (std.mem.eql(u8, value, "false")) false else return error.InvalidBoolean;
        } else if (std.mem.eql(u8, arg, "--signal")) {
            if (request.op != .signal_session) return error.UnexpectedOption;
            request.signal = value;
        } else if (std.mem.eql(u8, arg, "--log")) {
            if (request.op != .new_session) return error.UnexpectedOption;
            request.log_path = try std.fs.path.resolve(allocator, &.{ cwd, value });
        } else if (std.mem.eql(u8, arg, "--status-path")) {
            if (request.op != .new_session) return error.UnexpectedOption;
            request.status_path = try std.fs.path.resolve(allocator, &.{ cwd, value });
        } else if (std.mem.eql(u8, arg, "--offset")) {
            if (request.op != .read_output and request.op != .subscribe_output) return error.UnexpectedOption;
            request.offset = try std.fmt.parseInt(u64, value, 10);
        } else if (std.mem.eql(u8, arg, "--limit")) {
            if (request.op != .read_output) return error.UnexpectedOption;
            request.limit = try std.fmt.parseInt(u32, value, 10);
            if (request.limit == 0 or request.limit > wire.max_output_chunk) return error.InvalidReadLimit;
        } else if (std.mem.eql(u8, arg, "--cols") or std.mem.eql(u8, arg, "--rows")) {
            if (request.op != .new_session and request.op != .resize_window) return error.UnexpectedOption;
            const number = try std.fmt.parseInt(u16, value, 10);
            if (std.mem.eql(u8, arg, "--cols")) request.cols = number else request.rows = number;
            dimensions |= if (std.mem.eql(u8, arg, "--cols")) @as(u2, 1) else 2;
        } else if (std.mem.eql(u8, arg, "--cwd")) {
            if (request.op != .new_session) return error.UnexpectedOption;
            request.cwd = try std.fs.path.resolve(allocator, &.{ cwd, value });
        } else if (std.mem.eql(u8, arg, "--output")) {
            if (request.op != .screenshot) return error.UnexpectedOption;
            request.path = try std.fs.path.resolve(allocator, &.{ cwd, value });
        } else if (std.mem.eql(u8, arg, "--font-size")) {
            if (request.op != .screenshot) return error.UnexpectedOption;
            request.font_size = try std.fmt.parseInt(u16, value, 10);
        } else if (std.mem.eql(u8, arg, "--text")) {
            if (request.op != .send_input) return error.UnexpectedOption;
            input = value;
        } else return error.UnknownOption;
    }
    if (request.op == .subscribe_output) {
        if (request.uid) |uid| try wire.validate_uid(uid);
        if (request.uid == null and !json) return error.MultiplexRequiresJson;
    } else if (request.op != .list_sessions and request.op != .kill_server) {
        try wire.validate_uid(request.uid orelse return error.MissingUid);
    } else if (request.uid != null) return error.UnexpectedUid;
    try options.geometry(request.cols, request.rows);
    if (request.op == .resize_window and dimensions != 3) return error.MissingDimensions;
    if (!request.is_pty and dimensions != 0) return error.NotPty;
    try options.fontSize(request.font_size);
    if (request.op == .screenshot and request.path == null) return error.MissingOutputPath;
    if (request.op == .signal_session and request.signal == null) return error.MissingSignal;
    if (request.op == .new_session) {
        request.cwd = request.cwd orelse cwd;
        if (request.argv.len == 0) {
            const command = try allocator.alloc([]const u8, 1);
            command[0] = if (@import("builtin").os.tag == .windows) init.environ_map.get("COMSPEC") orelse "cmd.exe" else init.environ_map.get("SHELL") orelse "/bin/sh";
            request.argv = command;
        }
        var environment: std.ArrayList([]const u8) = .empty;
        var iterator = init.environ_map.iterator();
        while (iterator.next()) |entry| try environment.append(allocator, try std.fmt.allocPrint(allocator, "{s}={s}", .{ entry.key_ptr.*, entry.value_ptr.* }));
        request.env = try environment.toOwnedSlice(allocator);
    }
    if (request.op == .send_input) {
        const data = input orelse try read_input(allocator, init.io);
        if (data.len > 64 * 1024) return error.InputTooLarge;
        const encoder = std.base64.standard.Encoder;
        const encoded = try allocator.alloc(u8, encoder.calcSize(data.len));
        request.base64 = encoder.encode(encoded, data);
    }
    const path = try transport.socket_path(allocator, init.io, init.environ_map, explicit_socket);
    var startup: ?std.Io.File = try transport.lock_startup(allocator, init.io, path);
    defer if (startup) |lock| lock.close(init.io);
    const stream = try transport.connect_or_start(allocator, init.io, path, request.op == .new_session);
    defer stream.close(init.io);
    var decoded: [wire.max_output_chunk]u8 = undefined;
    {
        const response = try Channel.exchange(allocator, init.io, stream, request);
        defer response.deinit();
        startup.?.close(init.io);
        startup = null;
        if (!response.value.ok) {
            const message = try std.fmt.allocPrint(allocator, "ghostmux: {s}\n", .{response.value.error_name orelse "ServerCommandFailed"});
            try std.Io.File.stderr().writeStreamingAll(init.io, message);
            return error.RemoteFailure;
        }
        try print_response(init.io, response.value, json, &decoded);
    }
    _ = arena.reset(.free_all);
    if (request.op == .subscribe_output or request.subscribe) {
        while (true) {
            const next = try Channel.next_response(init.gpa, init.io, stream);
            defer next.deinit();
            if (!next.value.ok) return error.RemoteFailure;
            try print_response(init.io, next.value, json, &decoded);
            if (request.uid != null and std.mem.eql(u8, next.value.event orelse "", "exit")) return;
        }
    }
}

fn read_input(allocator: std.mem.Allocator, io: std.Io) ![]const u8 {
    const data = try allocator.alloc(u8, 64 * 1024 + 1);
    var length: usize = 0;
    while (length < data.len) {
        const count = std.Io.File.stdin().readStreaming(io, &.{data[length..]}) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        if (count == 0) break;
        length += count;
    }
    if (length == data.len) return error.InputTooLarge;
    return data[0..length];
}

fn print_response(io: std.Io, response: wire.Response, json: bool, decoded: []u8) !void {
    const stdout = std.Io.File.stdout();
    var buffer: [4096]u8 = undefined;
    var writer = stdout.writerStreaming(io, &buffer);
    if (json) {
        try std.json.Stringify.value(response, .{}, &writer.interface);
        try writer.interface.writeByte('\n');
    } else if (response.base64) |encoded| {
        const decoder = std.base64.standard.Decoder;
        const length = try decoder.calcSizeForSlice(encoded);
        if (length > decoded.len) return error.OutputTooLarge;
        const data = decoded[0..length];
        try decoder.decode(data, encoded);
        try writer.interface.writeAll(data);
    } else if (response.event != null) {
        return;
    } else if (response.text) |text| {
        try writer.interface.writeAll(text);
        if (text.len > 0) try writer.interface.writeByte('\n');
    } else if (response.path) |path| {
        try writer.interface.writeAll(path);
        try writer.interface.writeByte('\n');
    } else if (response.sessions) |sessions| {
        for (sessions) |session| try print_status(&writer.interface, session);
    } else if (response.session) |session| try print_status(&writer.interface, session);
    try writer.interface.flush();
}

fn print_status(writer: *std.Io.Writer, status: wire.Status) !void {
    try writer.print("{s}\tpid={d}\t", .{ status.uid, status.pid });
    if (status.is_pty) try writer.print("{d}x{d}", .{ status.cols, status.rows }) else try writer.writeAll("pipes");
    try writer.writeByte('\t');
    if (status.exit_code) |code| try writer.print("exited:{d}", .{code}) else try writer.writeAll("running");
    try writer.writeByte('\n');
}

pub const help =
    \\
    \\Runtime directory: ghostmux prepare-runtime DIRECTORY
    \\Server commands: ghostmux [-S SOCKET] COMMAND [options]
    \\  new-session   --uid ID [--is-pty true|false] [--subscribe] [--cwd DIR] [--log PATH] [--cols N --rows N] [-- COMMAND ARGS...]
    \\  list-sessions
    \\  capture-pane  --uid ID [--history] [--join]
    \\  screenshot    --uid ID --output PNG [--font-size N]
    \\  send-input    --uid ID [--text TEXT]   (otherwise reads stdin)
    \\  resize-window --uid ID --cols N --rows N
    \\  kill-session  --uid ID
    \\  signal-session --uid ID --signal NAME_OR_NUMBER
    \\  kill-server
    \\  read-output   --uid ID [--offset N --limit N]
    \\  subscribe-output [--uid ID] [--offset N] [--json]
    \\Add --json to return structured status and capture metadata.
    \\new-session starts the server automatically; completed sessions are removed.
    \\new-session --subscribe registers before launch and streams output through exit.
    \\new-session --status-path PATH persists initial and final session status.
    \\--is-pty false uses stdin EOF and merged stdout/stderr pipes, without terminal emulation.
    \\Subscriptions without a UID multiplex all sessions and require --json.
    \\
;
