const std = @import("std");
const wire = @import("wire.zig");
const options = @import("options.zig");
const platform = if (@import("builtin").os.tag == .windows) @import("terminal_windows.zig") else @import("terminal_posix.zig");

const Self = @This();
child: std.process.Child,
input: ?std.Io.File,
output: std.Io.File,
pid: i32,
terminal: platform.Terminal,

pub fn start(allocator: std.mem.Allocator, io: std.Io, request: wire.Request, cell_width: u32, cell_height: u32) !Self {
    try options.geometry(request.cols, request.rows);
    try validate(request);
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const spawned = if (request.is_pty)
        try platform.start(arena.allocator(), io, request, cell_width, cell_height)
    else
        try platform.start_pipes(arena.allocator(), io, request);
    return .{ .child = spawned.child, .input = spawned.input, .output = spawned.output, .pid = spawned.pid, .terminal = spawned.terminal };
}

pub fn resize(self: *Self, cols: u16, rows: u16, cell_width: u32, cell_height: u32) !void {
    if (self.input == null) return error.NotPty;
    try options.geometry(cols, rows);
    try self.terminal.resize(cols, rows, cell_width, cell_height);
}

pub fn finish_output(self: *Self, io: std.Io) void {
    self.terminal.finish_output(io);
}

pub fn signal(self: *Self, name: []const u8) !void {
    if (self.child.id == null) return error.ProcessNotFound;
    try self.terminal.signal(self.pid, name);
}

pub fn stop(self: *Self, io: std.Io) void {
    self.terminal.stop(self.pid);
    if (self.child.id != null) self.child.kill(io);
    self.finish_output(io);
}

pub fn deinit(self: *Self, io: std.Io) void {
    self.terminal.deinit(io);
}

fn validate(request: wire.Request) !void {
    if (request.argv.len == 0 or request.argv.len > 256 or request.argv[0].len == 0) return error.InvalidArguments;
    const cwd = request.cwd orelse return error.InvalidCwd;
    if (cwd.len == 0 or cwd.len > 4096 or !std.fs.path.isAbsolute(cwd) or std.mem.indexOfScalar(u8, cwd, 0) != null) return error.InvalidCwd;
    if (request.env.len > 1024) return error.InvalidEnvironment;
    var total: usize = 0;
    for (request.argv) |arg| {
        total += arg.len;
        if (arg.len > 4096 or total > 256 * 1024 or std.mem.indexOfScalar(u8, arg, 0) != null) return error.InvalidArguments;
    }
    total = 0;
    for (request.env) |entry| {
        total += entry.len;
        const equal = std.mem.indexOfScalar(u8, entry, '=') orelse return error.InvalidEnvironment;
        if (equal == 0 or entry.len > 16384 or total > 256 * 1024 or std.mem.indexOfScalar(u8, entry, 0) != null) return error.InvalidEnvironment;
    }
}
