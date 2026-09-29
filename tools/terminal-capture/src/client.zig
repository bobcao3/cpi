const std = @import("std");
const c = @import("native.zig").c;
const wire = @import("wire.zig");
const options = @import("options.zig");
const transport = @import("transport.zig");
const Channel = @import("channel.zig");

pub fn is_command(args: []const [:0]const u8) bool {
    return args.len > 1 and (!std.mem.startsWith(u8, args[1], "-") or std.mem.eql(u8, args[1], "-S"));
}

fn operation(name: []const u8) !wire.Operation {
    inline for (.{ "new-session", "list-sessions", "capture-pane", "screenshot", "send-input", "resize-window", "kill-session", "kill-server" }, .{ .new_session, .list_sessions, .capture_pane, .screenshot, .send_input, .resize_window, .kill_session, .kill_server }) |text, op| {
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
    if (request.op != .list_sessions and request.op != .kill_server) {
        try wire.validate_uid(request.uid orelse return error.MissingUid);
    } else if (request.uid != null) return error.UnexpectedUid;
    try options.geometry(request.cols, request.rows);
    if (request.op == .resize_window and dimensions != 3) return error.MissingDimensions;
    try options.fontSize(request.font_size);
    if (request.op == .screenshot and request.path == null) return error.MissingOutputPath;
    if (request.op == .new_session) {
        request.cwd = request.cwd orelse cwd;
        if (request.argv.len == 0) {
            const command = try allocator.alloc([]const u8, 1);
            command[0] = init.environ_map.get("SHELL") orelse "/bin/sh";
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
    const path = try transport.socket_path(allocator, explicit_socket);
    const fd = try transport.connect_or_start(allocator, path, request.op == .new_session);
    defer _ = c.close(fd);
    const response = try Channel.exchange(allocator, fd, request);
    defer response.deinit();
    if (!response.value.ok) {
        const message = try std.fmt.allocPrint(allocator, "terminal-capture: {s}\n", .{response.value.error_name orelse "ServerCommandFailed"});
        try std.Io.File.stderr().writeStreamingAll(init.io, message);
        return error.RemoteFailure;
    }
    try print_response(allocator, init.io, response.value, json);
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

fn print_response(allocator: std.mem.Allocator, io: std.Io, response: wire.Response, json: bool) !void {
    const stdout = std.Io.File.stdout();
    if (json) {
        try stdout.writeStreamingAll(io, try std.json.Stringify.valueAlloc(allocator, response, .{}));
        try stdout.writeStreamingAll(io, "\n");
    } else if (response.text) |text| {
        try stdout.writeStreamingAll(io, text);
        if (text.len > 0) try stdout.writeStreamingAll(io, "\n");
    } else if (response.path) |path| {
        try stdout.writeStreamingAll(io, path);
        try stdout.writeStreamingAll(io, "\n");
    } else if (response.sessions) |sessions| {
        for (sessions) |session| try print_status(allocator, io, session);
    } else if (response.session) |session| try print_status(allocator, io, session);
}

fn print_status(allocator: std.mem.Allocator, io: std.Io, status: wire.Status) !void {
    const state = if (status.exit_code) |code| try std.fmt.allocPrint(allocator, "exited:{d}", .{code}) else "running";
    const line = try std.fmt.allocPrint(allocator, "{s}\tpid={d}\t{d}x{d}\t{s}\n", .{ status.uid, status.pid, status.cols, status.rows, state });
    try std.Io.File.stdout().writeStreamingAll(io, line);
}

pub const help =
    \\
    \\Server commands (Linux): terminal-capture [-S SOCKET] COMMAND [options]
    \\  new-session   --uid ID [--cwd DIR] [--cols N --rows N] [-- COMMAND ARGS...]
    \\  list-sessions
    \\  capture-pane  --uid ID [--history] [--join]
    \\  screenshot    --uid ID --output PNG [--font-size N]
    \\  send-input    --uid ID [--text TEXT]   (otherwise reads stdin)
    \\  resize-window --uid ID --cols N --rows N
    \\  kill-session  --uid ID
    \\  kill-server
    \\Add --json to return structured status and capture metadata.
    \\new-session starts the server automatically; completed sessions remain capturable.
    \\
;
