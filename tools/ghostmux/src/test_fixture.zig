const std = @import("std");
pub const io = std.testing.io;
pub const allocator = std.testing.allocator;
pub const wire = @import("wire.zig");
pub const Channel = @import("channel.zig");
const options = @import("test_options");
pub const binary = if (std.fs.path.isAbsolute(options.binary)) options.binary else std.fmt.comptimePrint("{s}/{s}", .{ options.project, options.binary });
pub const windows = @import("builtin").os.tag == .windows;
pub const python = if (windows) "python" else "python3";
pub const Parsed = std.json.Parsed(wire.Response);

pub fn pause() !void {
    try std.Io.sleep(io, .fromMilliseconds(20), .awake);
}

pub fn next(stream: std.Io.net.Stream) !Parsed {
    var watchdog: std.Io.Group = .init;
    try watchdog.concurrent(io, @import("runtime_frames.zig").watchdog, .{ io, stream });
    defer watchdog.cancel(io);
    return Channel.next_response(allocator, io, stream);
}

pub fn run(args: []const []const u8) !std.process.RunResult {
    return std.process.run(allocator, io, .{
        .argv = args,
        .stdout_limit = .limited(10 * 1024 * 1024),
        .stderr_limit = .limited(1024 * 1024),
        .timeout = .{ .duration = .{ .raw = .fromSeconds(15), .clock = .awake } },
    });
}

pub fn free_result(result: std.process.RunResult) void {
    allocator.free(result.stdout);
    allocator.free(result.stderr);
}

pub fn success(result: std.process.RunResult) !void {
    if (result.term != .exited or result.term.exited != 0) {
        std.debug.print("child failed: {s}\n", .{result.stderr});
        return error.ChildFailed;
    }
}

pub const Fixture = struct {
    tmp: std.testing.TmpDir,
    directory: [:0]const u8,
    socket: [:0]const u8,

    pub fn init() !Fixture {
        var tmp = std.testing.tmpDir(.{});
        errdefer tmp.cleanup();
        if (windows) {
            const parent = try tmp.dir.realPathFileAlloc(io, ".", allocator);
            defer allocator.free(parent);
            const private_directory = try std.fs.path.join(allocator, &.{ parent, "s" });
            defer allocator.free(private_directory);
            try @import("runtime_windows_security.zig").create(allocator, private_directory);
        } else try tmp.dir.createDir(io, "s", .fromMode(0o700));
        const directory = try tmp.dir.realPathFileAlloc(io, "s", allocator);
        errdefer allocator.free(directory);
        const socket = try std.fmt.allocPrintSentinel(allocator, "{s}{c}s", .{ directory, std.fs.path.sep }, 0);
        return .{ .tmp = tmp, .directory = directory, .socket = socket };
    }

    pub fn deinit(self: *Fixture) void {
        if (self.cli(&.{"kill-server"})) |result| free_result(result) else |_| {}
        allocator.free(self.socket);
        allocator.free(self.directory);
        self.tmp.cleanup();
    }

    pub fn path(self: *const Fixture, name: []const u8) ![]u8 {
        return std.fs.path.join(allocator, &.{ self.directory, name });
    }

    pub fn cli(self: *const Fixture, args: []const []const u8) !std.process.RunResult {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(allocator);
        try argv.appendSlice(allocator, &.{ binary, "-S", self.socket });
        try argv.appendSlice(allocator, args);
        return run(argv.items);
    }

    pub fn request(self: *const Fixture, args: []const []const u8) !Parsed {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(allocator);
        const separator = for (args, 0..) |arg, i| {
            if (std.mem.eql(u8, arg, "--")) break i;
        } else args.len;
        try argv.appendSlice(allocator, args[0..separator]);
        try argv.append(allocator, "--json");
        try argv.appendSlice(allocator, args[separator..]);
        const result = try self.cli(argv.items);
        defer free_result(result);
        try success(result);
        const parsed = try std.json.parseFromSlice(wire.Response, allocator, result.stdout, .{});
        errdefer parsed.deinit();
        try std.testing.expect(parsed.value.ok);
        return parsed;
    }

    pub fn launch(self: *const Fixture, uid: []const u8, pty: bool, code: []const u8) !Parsed {
        return self.request(&.{ "new-session", "--uid", uid, "--is-pty", if (pty) "true" else "false", "--", python, "-c", code });
    }

    pub fn connect(self: *const Fixture) !std.Io.net.Stream {
        return @import("transport.zig").connect_or_start(allocator, io, self.socket, false);
    }

    pub fn exchange(self: *const Fixture, request_value: wire.Request) !Parsed {
        const stream = try self.connect();
        defer stream.close(io);
        return Channel.exchange(allocator, io, stream, request_value);
    }

    pub fn wait_bytes(self: *const Fixture, uid: []const u8, bytes: u64) !Parsed {
        for (0..400) |_| {
            const response = try self.exchange(.{ .op = .read_output, .uid = uid, .offset = bytes, .limit = 1 });
            if (response.value.ok and response.value.session.?.bytes >= bytes) return response;
            response.deinit();
            try pause();
        }
        return error.OutputDeadline;
    }

    pub fn wait_text(self: *const Fixture, uid: []const u8, needle: []const u8) !Parsed {
        for (0..400) |_| {
            const response = try self.exchange(.{ .op = .capture_pane, .uid = uid });
            if (response.value.ok and std.mem.indexOf(u8, response.value.text.?, needle) != null) return response;
            response.deinit();
            try pause();
        }
        return error.CaptureDeadline;
    }

    pub fn send(self: *const Fixture, uid: []const u8, data: []const u8) !void {
        const encoder = std.base64.standard.Encoder;
        const encoded = try allocator.alloc(u8, encoder.calcSize(data.len));
        defer allocator.free(encoded);
        const response = try self.exchange(.{ .op = .send_input, .uid = uid, .base64 = encoder.encode(encoded, data) });
        defer response.deinit();
        try std.testing.expect(response.value.ok);
    }

    pub fn read_file(self: *const Fixture, name: []const u8) ![]u8 {
        const file_path = try self.path(name);
        defer allocator.free(file_path);
        return std.Io.Dir.cwd().readFileAlloc(io, file_path, allocator, .limited(10 * 1024 * 1024));
    }
};

pub fn decode(response: wire.Response) ![]u8 {
    const decoder = std.base64.standard.Decoder;
    const encoded = response.base64 orelse return error.MissingOutput;
    const bytes = try allocator.alloc(u8, try decoder.calcSizeForSlice(encoded));
    errdefer allocator.free(bytes);
    try decoder.decode(bytes, encoded);
    return bytes;
}

pub fn expect_error(response: wire.Response, name: []const u8) !void {
    if (response.ok) std.debug.print("expected rejection {s}, got success\n", .{name});
    try std.testing.expect(!response.ok);
    try std.testing.expectEqualStrings(name, response.error_name.?);
}
