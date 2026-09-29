const std = @import("std");
const ghostty = @import("ghostty-vt");
const c = @import("native.zig").c;
const wire = @import("wire.zig");
const options = @import("options.zig");
const Session = @import("session.zig");
const spawn = @import("app_spawn.zig");
const App = @This();

allocator: std.mem.Allocator,
arena: std.heap.ArenaAllocator,
uid: []const u8,
session: Session,
pid: c_int,
master: c_int = -1,
exit_code: ?i32 = null,
bytes: u64 = 0,
cols: u16,
rows: u16,
cell_width: u32,
cell_height: u32,
reaped: bool = false,
response_error: ?anyerror = null,
input: [64 * 1024]u8 = undefined,
input_start: usize = 0,
input_end: usize = 0,

pub fn create(allocator: std.mem.Allocator, io: std.Io, request: wire.Request) !*App {
    const uid = request.uid orelse return error.InvalidUid;
    try wire.validate_uid(uid);
    try options.geometry(request.cols, request.rows);
    const metrics = try @import("font.zig").metrics((options.Options{}).font_size);
    const self = try allocator.create(App);
    errdefer allocator.destroy(self);
    self.* = .{
        .allocator = allocator,
        .arena = std.heap.ArenaAllocator.init(allocator),
        .uid = undefined,
        .session = undefined,
        .pid = -1,
        .cols = request.cols,
        .rows = request.rows,
        .cell_width = @intCast(metrics.width),
        .cell_height = @intCast(metrics.height),
    };
    errdefer self.arena.deinit();
    self.uid = try self.arena.allocator().dupe(u8, uid);
    try self.session.init(allocator, io, .{ .cols = request.cols, .rows = request.rows });
    errdefer self.session.deinit();
    self.session.stream.handler.effects.write_pty = writePty;
    self.session.stream.handler.effects.device_attributes = deviceAttributes;
    self.session.stream.handler.effects.size = sizeReport;
    try self.session.stream.handler.resize(.{ .cols = request.cols, .rows = request.rows, .cell_size_px = .{ .width = self.cell_width, .height = self.cell_height } });
    const child = try spawn.start(self.arena.allocator(), request, self.cell_width, self.cell_height);
    self.pid = child.pid;
    self.master = child.master;
    return self;
}

pub fn deinit(self: *App) void {
    std.debug.assert(!self.reaped or self.master < 0);
    if (!self.reaped) {
        spawn.stop(self.pid, self.master);
    }
    self.session.deinit();
    self.arena.deinit();
    self.allocator.destroy(self);
}

pub fn events(self: *const App) c_short {
    if (self.master < 0) return 0;
    return @intCast(c.POLLIN | (if (self.input_start < self.input_end) @as(c_int, c.POLLOUT) else 0));
}

pub fn step(self: *App, revents: c_short) !void {
    if (self.master >= 0 and (revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
        var buffer: [16 * 1024]u8 = undefined;
        var remaining: usize = 256 * 1024;
        while (remaining > 0) {
            const count = c.read(self.master, &buffer, @min(buffer.len, remaining));
            if (count < 0) {
                const reason = std.c.errno(count);
                if (reason == .INTR) continue;
                if (reason == .AGAIN) break;
                if (reason == .IO) {
                    self.closeMaster();
                    break;
                }
                return error.PtyReadFailed;
            }
            if (count == 0) {
                self.closeMaster();
                break;
            }
            const length: usize = @intCast(count);
            try self.session.feed(buffer[0..length]);
            if (self.response_error) |err| return err;
            self.bytes = std.math.add(u64, self.bytes, length) catch return error.OutputTooLarge;
            remaining -= length;
        }
    }
    if (self.master >= 0 and (revents & c.POLLOUT) != 0) try self.flush();
    try self.reap();
}

pub fn send(self: *App, data: []const u8) !void {
    if (self.master < 0) return error.SessionExited;
    try self.flush();
    if (data.len > self.input.len - (self.input_end - self.input_start)) return error.InputQueueFull;
    if (self.input.len - self.input_end < data.len) {
        const length = self.input_end - self.input_start;
        std.mem.copyForwards(u8, self.input[0..length], self.input[self.input_start..self.input_end]);
        self.input_start = 0;
        self.input_end = length;
    }
    @memcpy(self.input[self.input_end..][0..data.len], data);
    self.input_end += data.len;
    try self.flush();
}

pub fn resize(self: *App, cols: u16, rows: u16) !void {
    try options.geometry(cols, rows);
    if (self.master < 0) return error.SessionExited;
    var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
    size.ws_col = cols;
    size.ws_row = rows;
    size.ws_xpixel = @intCast(@as(u32, cols) * self.cell_width);
    size.ws_ypixel = @intCast(@as(u32, rows) * self.cell_height);
    if (c.ioctl(self.master, c.TIOCSWINSZ, &size) != 0) return error.PtyResizeFailed;
    self.cols = cols;
    self.rows = rows;
    try self.session.stream.handler.resize(.{ .cols = cols, .rows = rows, .cell_size_px = .{ .width = self.cell_width, .height = self.cell_height } });
    if (self.response_error) |err| return err;
}

pub fn status(self: *const App) wire.Status {
    return .{
        .uid = self.uid,
        .pid = self.pid,
        .cols = self.cols,
        .rows = self.rows,
        .bytes = self.bytes,
        .exit_code = if (self.master < 0) self.exit_code else null,
    };
}

fn flush(self: *App) !void {
    while (self.input_start < self.input_end and self.master >= 0) {
        const count = c.write(self.master, self.input[self.input_start..self.input_end].ptr, self.input_end - self.input_start);
        if (count < 0) {
            const reason = std.c.errno(count);
            if (reason == .INTR) continue;
            if (reason == .AGAIN) return;
            if (reason == .IO) {
                self.closeMaster();
                return error.SessionExited;
            }
            return error.PtyWriteFailed;
        }
        if (count == 0) return;
        self.input_start += @intCast(count);
    }
    if (self.input_start == self.input_end) {
        self.input_start = 0;
        self.input_end = 0;
    }
}

fn closeMaster(self: *App) void {
    if (self.master < 0) return;
    _ = c.close(self.master);
    self.master = -1;
    self.input_start = 0;
    self.input_end = 0;
}

fn reap(self: *App) !void {
    // Keep the leader waitable until PTY EOF so cleanup cannot signal a recycled PID.
    if (self.reaped or self.master >= 0) return;
    var status_code: c_int = 0;
    const result = c.waitpid(self.pid, &status_code, c.WNOHANG);
    if (result == 0) return;
    if (result < 0) {
        if (std.c.errno(result) == .INTR) return;
        return error.ChildWaitFailed;
    }
    self.reaped = true;
    self.exit_code = if (c.WIFEXITED(status_code)) c.WEXITSTATUS(status_code) else if (c.WIFSIGNALED(status_code)) 128 + c.WTERMSIG(status_code) else 255;
}

fn writePty(handler: *ghostty.TerminalStream.Handler, data: []const u8) void {
    const stream: *ghostty.TerminalStream = @fieldParentPtr("handler", handler);
    const self: *App = @fieldParentPtr("session", @as(*Session, @fieldParentPtr("stream", stream)));
    self.send(data) catch |err| {
        self.response_error = err;
    };
}

const Attributes = @typeInfo(@typeInfo(@typeInfo(@TypeOf(@as(ghostty.TerminalStream.Handler.Effects, undefined).device_attributes)).optional.child).pointer.child).@"fn".return_type.?;

fn deviceAttributes(_: *ghostty.TerminalStream.Handler) Attributes {
    return .{};
}

fn sizeReport(handler: *ghostty.TerminalStream.Handler) ?ghostty.size_report.Size {
    const stream: *ghostty.TerminalStream = @fieldParentPtr("handler", handler);
    const self: *App = @fieldParentPtr("session", @as(*Session, @fieldParentPtr("stream", stream)));
    return .{ .columns = self.cols, .rows = self.rows, .cell_width = self.cell_width, .cell_height = self.cell_height };
}
