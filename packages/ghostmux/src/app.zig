const std = @import("std");
const ghostty = @import("ghostty-vt");
const wire = @import("wire.zig");
const options = @import("options.zig");
const Session = @import("session.zig");
const Process = @import("managed_process.zig");
const Output = @import("output.zig");
const App = @This();
const frames = @import("runtime_frames.zig");

pub const Observer = struct {
    context: *anyopaque,
    send: *const fn (*anyopaque, *frames.Shared) anyerror!void,
    ready: *const fn (*anyopaque) bool,
    completed: bool = false,
};

allocator: std.mem.Allocator,
io: std.Io,
mutex: std.Io.Mutex = .init,
arena: std.heap.ArenaAllocator,
uid: []const u8,
is_pty: bool,
session: Session,
output: Output,
status_file: ?@import("status_file.zig") = null,
process: ?Process = null,
pid: i32 = 0,
exit_code: ?i32 = null,
exit_at: ?i64 = null,
last_output_at: i64,
cols: u16,
rows: u16,
cell_width: u32,
cell_height: u32,
drained: bool = false,
output_finishing: bool = false,
reader_done: bool = false,
output_pending: bool = false,
failure: ?anyerror = null,
response_error: ?anyerror = null,
read_group: std.Io.Group = .init,
write_group: std.Io.Group = .init,
wait_group: std.Io.Group = .init,
input_event: std.Io.Event = .unset,
input: [64 * 1024]u8 = undefined,
input_end: usize = 0,
observers: std.ArrayList(Observer) = .empty,

pub fn create(allocator: std.mem.Allocator, io: std.Io, request: wire.Request) !*App {
    const uid = request.uid orelse return error.InvalidUid;
    try wire.validate_uid(uid);
    try options.geometry(request.cols, request.rows);
    const self = try allocator.create(App);
    errdefer allocator.destroy(self);
    self.* = .{
        .allocator = allocator,
        .io = io,
        .arena = std.heap.ArenaAllocator.init(allocator),
        .uid = undefined,
        .is_pty = request.is_pty,
        .session = undefined,
        .output = undefined,
        .last_output_at = std.Io.Clock.awake.now(io).toMilliseconds(),
        .cols = if (request.is_pty) request.cols else 0,
        .rows = if (request.is_pty) request.rows else 0,
        .cell_width = 0,
        .cell_height = 0,
    };
    errdefer self.arena.deinit();
    self.uid = try self.arena.allocator().dupe(u8, uid);
    if (request.status_path) |path| self.status_file = try @import("status_file.zig").init(self.arena.allocator(), io, path);
    errdefer if (self.status_file) |*file| file.deinit(io);
    self.output = try Output.init(allocator, io, request.log_path);
    errdefer self.output.deinit();
    if (self.is_pty) {
        const metrics = try @import("font.zig").metrics((options.Options{}).font_size);
        self.cell_width = @intCast(metrics.width);
        self.cell_height = @intCast(metrics.height);
        try self.session.init(allocator, io, .{ .cols = request.cols, .rows = request.rows });
        errdefer self.session.deinit();
        self.session.stream.handler.effects.write_pty = writePty;
        self.session.stream.handler.effects.device_attributes = deviceAttributes;
        self.session.stream.handler.effects.size = sizeReport;
        try self.session.stream.handler.resize(.{ .cols = request.cols, .rows = request.rows, .cell_size_px = .{ .width = self.cell_width, .height = self.cell_height } });
    }
    return self;
}

pub fn spawn(self: *App, request: wire.Request) !void {
    std.debug.assert(self.process == null);
    self.process = try Process.start(self.allocator, self.io, request, self.cell_width, self.cell_height);
    self.pid = self.process.?.pid;
    if (self.status_file) |*file| try file.write(self.io, self.status(), null);
}

pub fn start(self: *App) !void {
    std.debug.assert(self.process != null);
    std.debug.assert(self.is_pty == (self.process.?.input != null));
    errdefer self.terminate(255);
    try self.read_group.concurrent(self.io, read_output, .{self});
    if (self.is_pty) try self.write_group.concurrent(self.io, write_input, .{self});
    try self.wait_group.concurrent(self.io, wait_child, .{self});
}

pub fn observer(self: *App, context: *anyopaque) ?*Observer {
    for (self.observers.items) |*value| {
        if (value.context == context) return value;
    }
    return null;
}

pub fn add_observer(self: *App, context: *anyopaque, send_callback: @FieldType(Observer, "send"), ready_callback: @FieldType(Observer, "ready")) !*Observer {
    std.debug.assert(self.observer(context) == null);
    try self.observers.append(self.allocator, .{ .context = context, .send = send_callback, .ready = ready_callback });
    return &self.observers.items[self.observers.items.len - 1];
}

pub fn remove_observer(self: *App, context: *anyopaque) void {
    for (self.observers.items, 0..) |value, index| {
        if (value.context == context) {
            _ = self.observers.swapRemove(index);
            return;
        }
    }
}

pub fn deinit(self: *App) void {
    if (self.process != null and !self.drained) self.terminate(137);
    self.cancel_tasks();
    self.persist_final_status() catch |err| std.log.err("final session status failed: {s}", .{@errorName(err)});
    if (self.status_file) |*file| file.deinit(self.io);
    if (self.process) |*process| process.deinit(self.io);
    self.output.deinit();
    self.observers.deinit(self.allocator);
    if (self.is_pty) self.session.deinit();
    self.arena.deinit();
    self.allocator.destroy(self);
}

pub fn terminate(self: *App, code: i32) void {
    std.debug.assert(self.process != null);
    self.wait_group.cancel(self.io);
    self.process.?.stop(self.io);
    self.read_group.cancel(self.io);
    self.write_group.cancel(self.io);
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    self.exit_code = code;
    self.drained = true;
}

pub fn step(self: *App) !void {
    self.mutex.lockUncancelable(self.io);
    const failure = self.failure;
    const now = std.Io.Clock.awake.now(self.io).toMilliseconds();
    const exited = self.exit_at != null;
    const complete = if (self.exit_at) |exit_at| self.reader_done or
        (now - exit_at >= 50 and now - self.last_output_at >= 50 and !self.output_pending) or
        now - exit_at >= 1000 else false;
    self.mutex.unlock(self.io);
    if (failure) |err| return err;
    if (exited and !self.output_finishing) {
        self.output_finishing = true;
        self.process.?.finish_output(self.io);
    }
    if (!complete or self.drained) return;
    self.cancel_tasks();
    self.process.?.stop(self.io);
    self.mutex.lockUncancelable(self.io);
    self.drained = true;
    self.mutex.unlock(self.io);
}

pub fn send(self: *App, data: []const u8) !void {
    if (!self.is_pty) return error.NotPty;
    if (self.drained) return error.SessionExited;
    if (data.len > self.input.len - self.input_end) return error.InputQueueFull;
    @memcpy(self.input[self.input_end..][0..data.len], data);
    self.input_end += data.len;
    self.input_event.set(self.io);
}

pub fn resize(self: *App, cols: u16, rows: u16) !void {
    if (!self.is_pty) return error.NotPty;
    try options.geometry(cols, rows);
    if (self.drained) return error.SessionExited;
    try self.process.?.resize(cols, rows, self.cell_width, self.cell_height);
    self.cols = cols;
    self.rows = rows;
    try self.session.stream.handler.resize(.{ .cols = cols, .rows = rows, .cell_size_px = .{ .width = self.cell_width, .height = self.cell_height } });
    if (self.response_error) |err| return err;
}

pub fn status(self: *const App) wire.Status {
    std.debug.assert(self.process != null);
    return .{ .uid = self.uid, .pid = self.pid, .cols = self.cols, .rows = self.rows, .bytes = self.output.end, .exit_code = if (self.drained) self.exit_code else null, .is_pty = self.is_pty };
}

pub fn persist_final_status(self: *App) !void {
    if (self.status_file) |*file| {
        if (!file.published or file.finished) return;
        self.mutex.lockUncancelable(self.io);
        const done = self.drained;
        const value = if (done) self.status() else null;
        const failure = self.failure;
        self.mutex.unlock(self.io);
        if (value) |status_value| try file.write(self.io, status_value, failure);
    }
}

pub fn terminal(self: *App) !*Session {
    if (!self.is_pty) return error.NotPty;
    return &self.session;
}

fn cancel_tasks(self: *App) void {
    self.wait_group.cancel(self.io);
    self.read_group.cancel(self.io);
    self.write_group.cancel(self.io);
}

fn read_output(self: *App) std.Io.Cancelable!void {
    var buffer: [16 * 1024]u8 = undefined;
    var discard = false;
    while (true) {
        const count = self.process.?.output.readStreaming(self.io, &.{&buffer}) catch |err| switch (err) {
            error.Canceled => return error.Canceled,
            error.EndOfStream, error.InputOutput => break,
            else => {
                self.record_failure(err);
                break;
            },
        };
        if (count == 0) break;
        if (discard) continue;
        try self.wait_output_capacity();
        self.ingest(buffer[0..count]) catch |err| {
            self.record_failure(err);
            discard = true;
        };
    }
    self.mutex.lockUncancelable(self.io);
    self.reader_done = true;
    self.mutex.unlock(self.io);
}

fn wait_output_capacity(self: *App) std.Io.Cancelable!void {
    while (true) {
        self.mutex.lockUncancelable(self.io);
        self.output_pending = true;
        const ready = self.exit_at != null or for (self.observers.items) |value| {
            if (!value.completed and !value.ready(value.context)) break false;
        } else true;
        self.mutex.unlock(self.io);
        if (ready) return;
        try std.Io.sleep(self.io, .fromMilliseconds(2), .awake);
    }
}

fn ingest(self: *App, data: []const u8) !void {
    const protection = self.io.swapCancelProtection(.blocked);
    defer _ = self.io.swapCancelProtection(protection);
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    defer self.output_pending = false;
    const offset = self.output.end;
    try self.output.append(data);
    var frame: ?*frames.Shared = null;
    defer if (frame) |value| value.release();
    for (self.observers.items) |*value| {
        if (value.completed) continue;
        if (frame == null) frame = try frames.data(self.allocator, self.uid, offset, data);
        value.send(value.context, frame.?) catch {
            value.completed = true;
        };
    }
    if (self.is_pty) try self.session.feed(data);
    self.last_output_at = std.Io.Clock.awake.now(self.io).toMilliseconds();
    if (self.response_error) |err| return err;
}

fn write_input(self: *App) std.Io.Cancelable!void {
    var buffer: [64 * 1024]u8 = undefined;
    while (true) {
        try self.input_event.wait(self.io);
        self.mutex.lockUncancelable(self.io);
        const length = self.input_end;
        @memcpy(buffer[0..length], self.input[0..length]);
        self.input_end = 0;
        self.input_event.reset();
        self.mutex.unlock(self.io);
        self.process.?.input.?.writeStreamingAll(self.io, buffer[0..length]) catch |err| switch (err) {
            error.Canceled => return error.Canceled,
            else => {
                self.mutex.lockUncancelable(self.io);
                if (self.exit_code == null) self.failure = err;
                self.mutex.unlock(self.io);
                return;
            },
        };
    }
}

fn wait_child(self: *App) std.Io.Cancelable!void {
    std.debug.assert(self.process.?.child.stdin == null and self.process.?.child.stdout == null and self.process.?.child.stderr == null);
    // POSIX wait cancellation clears the temporary Child ID without reaping the process.
    var waiting_child = self.process.?.child;
    const term = waiting_child.wait(self.io) catch |err| switch (err) {
        error.Canceled => return error.Canceled,
        else => {
            self.record_failure(err);
            return;
        },
    };
    self.mutex.lockUncancelable(self.io);
    self.process.?.child = waiting_child;
    self.exit_code = switch (term) {
        .exited => |code| code,
        .signal => |signal| 128 + @as(i32, @intCast(@intFromEnum(signal))),
        .stopped => |signal| 128 + @as(i32, @intCast(@intFromEnum(signal))),
        .unknown => |code| @bitCast(code),
    };
    self.exit_at = std.Io.Clock.awake.now(self.io).toMilliseconds();
    self.mutex.unlock(self.io);
}

fn record_failure(self: *App, err: anyerror) void {
    self.mutex.lockUncancelable(self.io);
    self.failure = err;
    self.mutex.unlock(self.io);
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
