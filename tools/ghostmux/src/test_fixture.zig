const std = @import("std");
pub const io = std.testing.io;
pub const allocator = std.testing.allocator;
pub const wire = @import("wire.zig");
pub const Channel = @import("channel.zig");
const options = @import("test_options");
pub const binary = if (std.fs.path.isAbsolute(options.binary)) options.binary else std.fmt.comptimePrint("{s}/{s}", .{ options.project, options.binary });
pub const windows = @import("builtin").os.tag == .windows;
pub const Program = @import("test_child.zig").Program;
pub const Child = struct { program: Program = .hold, output: []const u8 = "" };
pub const Parsed = std.json.Parsed(wire.Response);

pub fn child(program: Program) []const u8 {
    inline for (comptime std.meta.tags(Program)) |value| {
        if (program == value) {
            const path = @field(options, @tagName(value));
            std.debug.assert(path.len > 0);
            return if (std.fs.path.isAbsolute(path)) path else std.fmt.comptimePrint("{s}/{s}", .{ options.project, path });
        }
    }
    unreachable;
}

pub fn repeated(pattern: []const u8, length: usize) ![]u8 {
    std.debug.assert(pattern.len > 0 and length <= 4 * 1024 * 1024);
    const bytes = try allocator.alloc(u8, length);
    for (bytes, 0..) |*byte, i| byte.* = pattern[i % pattern.len];
    return bytes;
}

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
    daemon: ?std.process.Child = null,

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
        if (self.exchange(.{ .op = .kill_server })) |response| response.deinit() else |_| {}
        if (self.daemon) |*daemon| daemon.kill(io);
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

    pub fn cli_request(self: *const Fixture, args: []const []const u8) !Parsed {
        const result = try self.cli(args);
        defer free_result(result);
        try success(result);
        const parsed = try std.json.parseFromSlice(wire.Response, allocator, result.stdout, .{ .allocate = .alloc_always });
        errdefer parsed.deinit();
        try std.testing.expect(parsed.value.ok);
        return parsed;
    }

    pub fn prepare(self: *const Fixture, uid: []const u8, output: []const u8) ![]u8 {
        try wire.validate_uid(uid);
        std.debug.assert(output.len <= 4 * 1024 * 1024);
        const directory = try self.path(uid);
        errdefer allocator.free(directory);
        try std.Io.Dir.cwd().createDirPath(io, directory);
        var dir = try std.Io.Dir.openDirAbsolute(io, directory, .{});
        defer dir.close(io);
        try dir.writeFile(io, .{ .sub_path = "output", .data = output });
        return directory;
    }

    pub fn launch(self: *Fixture, request: wire.Request, program: Child) !Parsed {
        std.debug.assert(request.op == .new_session and !request.subscribe);
        const directory = try self.prepare(request.uid.?, program.output);
        defer allocator.free(directory);
        const guard = try @import("transport.zig").lock_startup(allocator, io, self.socket);
        defer guard.close(io);
        const stream = try self.start();
        defer stream.close(io);
        var value = request;
        value.cwd = directory;
        value.argv = &.{child(program.program)};
        const response = try Channel.exchange(allocator, io, stream, value);
        errdefer response.deinit();
        try std.testing.expect(response.value.ok);
        return response;
    }

    fn start(self: *Fixture) !std.Io.net.Stream {
        if (self.connect()) |stream| return stream else |err| switch (err) {
            error.SocketMissing, error.FileNotFound, error.ConnectionRefused, error.Unexpected => {},
            else => return err,
        }
        if (self.daemon) |*daemon| daemon.kill(io);
        self.daemon = try std.process.spawn(io, .{ .argv = &.{ binary, "--serve", self.socket }, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore, .create_no_window = windows });
        for (0..400) |_| {
            if (self.connect()) |stream| return stream else |err| switch (err) {
                error.SocketMissing, error.FileNotFound, error.ConnectionRefused, error.Unexpected => {},
                else => return err,
            }
            try pause();
        }
        return error.StartupDeadline;
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

pub fn expect_output(expected: []const u8, actual: []const u8, pty: bool) !void {
    if (!pty) return std.testing.expectEqualStrings(expected, actual);
    var session: @import("session.zig") = undefined;
    try session.init(allocator, io, .{});
    defer session.deinit();
    try session.feed(actual);
    const text = try session.capture(allocator, false, true);
    defer allocator.free(text);
    try std.testing.expectEqualStrings(expected, text);
}
