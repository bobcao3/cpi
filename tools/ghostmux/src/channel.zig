const std = @import("std");
const wire = @import("wire.zig");
const transport = @import("transport.zig");
const frames = @import("runtime_frames.zig");
const Self = @This();
const Replay = @import("replay.zig");
const Entry = union(enum) { frame: *frames.Shared, replay: *Replay };
const replay_budget = 64 * 1024 * 1024;

allocator: std.mem.Allocator,
io: std.Io,
stream: std.Io.net.Stream,
group: std.Io.Group = .init,
read_group: std.Io.Group = .init,
mutex: std.Io.Mutex = .init,
ready: std.Io.Event = .unset,
closed: std.atomic.Value(bool) = .init(false),
handled: std.atomic.Value(bool) = .init(false),
deadline: std.atomic.Value(i64),
subscribed: bool = false,
subscription_uid: ?[]u8 = null,
subscription_offset: u64 = 0,
closing: bool = false,
finish: std.atomic.Value(bool) = .init(false),
queue: std.ArrayList(Entry) = .empty,
replay_bytes: usize = 0,
queue_bytes: usize = 0,
context: *anyopaque = undefined,
dispatch: *const fn (*anyopaque, *Self, []const u8) anyerror!void = undefined,

pub fn init(allocator: std.mem.Allocator, io: std.Io, stream: std.Io.net.Stream) !*Self {
    const self = try allocator.create(Self);
    self.* = .{ .allocator = allocator, .io = io, .stream = stream, .deadline = .init(transport.now_ms(io) + wire.timeout_ms) };
    return self;
}

pub fn start(self: *Self, context: *anyopaque, dispatch: @TypeOf(@as(Self, undefined).dispatch)) !void {
    self.context = context;
    self.dispatch = dispatch;
    try self.group.concurrent(self.io, worker, .{self});
}

pub fn stop(self: *Self) void {
    self.group.cancel(self.io);
    self.read_group.cancel(self.io);
}

pub fn deinit(self: *Self) void {
    self.stop();
    self.stream.close(self.io);
    for (self.queue.items) |entry| switch (entry) {
        .frame => |frame| frame.release(),
        .replay => |snapshot| snapshot.deinit(),
    };
    self.queue.deinit(self.allocator);
    if (self.subscription_uid) |uid| self.allocator.free(uid);
    self.allocator.destroy(self);
}

pub fn sync_closing(self: *Self) void {
    if (self.closing) {
        self.finish.store(true, .release);
        self.ready.set(self.io);
    }
}

pub fn respond(self: *Self, value: wire.Response) !void {
    const frame = try frames.Shared.create(self.allocator, value);
    defer frame.release();
    try self.enqueue(frame);
}

pub fn enqueue(self: *Self, frame: *frames.Shared) !void {
    try self.mutex.lock(self.io);
    defer self.mutex.unlock(self.io);
    if (self.closed.load(.acquire)) return error.ConnectionClosed;
    const bytes = frame.bytes.len + @sizeOf(Entry);
    if (bytes > wire.max_response - self.queue_bytes) return error.ResponseTooLarge;
    try self.queue.append(self.allocator, .{ .frame = frame });
    frame.retain();
    self.queue_bytes += bytes;
    self.ready.set(self.io);
}

pub fn output_ready(self: *Self) bool {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    return self.closed.load(.acquire) or self.finish.load(.acquire) or
        self.queue_bytes < 2 * 1024 * 1024;
}

pub fn replay(self: *Self, uid: []const u8, output: *const @import("output.zig"), offset: u64) !void {
    if (offset == output.end) return;
    const snapshot = try Replay.snapshot(self.allocator, uid, output, offset);
    errdefer snapshot.deinit();
    try self.mutex.lock(self.io);
    defer self.mutex.unlock(self.io);
    if (self.closed.load(.acquire)) return error.ConnectionClosed;
    const bytes = replay_size(snapshot);
    if (bytes > replay_budget - self.replay_bytes) return error.ResponseTooLarge;
    try self.queue.append(self.allocator, .{ .replay = snapshot });
    self.replay_bytes += bytes;
    self.ready.set(self.io);
}

fn worker(self: *Self) std.Io.Cancelable!void {
    defer self.closed.store(true, .release);
    self.work() catch {};
    self.read_group.cancel(self.io);
}

fn work(self: *Self) !void {
    var reader = self.stream.reader(self.io, &.{});
    {
        const body = try frames.read(self.allocator, &reader.interface, wire.max_request);
        defer self.allocator.free(body);
        try self.dispatch(self.context, self, body);
    }
    if (self.subscribed) try self.read_group.concurrent(self.io, monitor, .{self});
    var writer = self.stream.writer(self.io, &.{});
    while (true) {
        try self.mutex.lock(self.io);
        if (self.queue.items.len == 0) {
            self.ready.reset();
            self.deadline.store(std.math.maxInt(i64), .release);
            self.mutex.unlock(self.io);
            if (!self.subscribed or self.finish.load(.acquire) or self.closed.load(.acquire)) return;
            try self.ready.wait(self.io);
            continue;
        }
        const frame = self.take() catch |err| {
            self.mutex.unlock(self.io);
            return err;
        };
        self.deadline.store(transport.now_ms(self.io) + wire.timeout_ms, .release);
        self.mutex.unlock(self.io);
        defer frame.release();
        try writer.interface.writeAll(frame.bytes);
        try writer.interface.flush();
        if (self.closed.load(.acquire)) return;
        try self.mutex.lock(self.io);
        const done = self.queue.items.len == 0 and (!self.subscribed or self.finish.load(.acquire));
        self.mutex.unlock(self.io);
        if (done) return;
    }
}

fn take(self: *Self) !*frames.Shared {
    const entry = &self.queue.items[0];
    var remove = true;
    const frame = switch (entry.*) {
        .frame => |frame| result: {
            self.queue_bytes -= frame.bytes.len + @sizeOf(Entry);
            break :result frame;
        },
        .replay => |snapshot| result: {
            const frame = try snapshot.next();
            remove = snapshot.offset == snapshot.end;
            if (remove) {
                self.replay_bytes -= replay_size(snapshot);
                snapshot.deinit();
            }
            break :result frame;
        },
    };
    if (remove) {
        _ = self.queue.orderedRemove(0);
    }
    return frame;
}

fn replay_size(snapshot: *const Replay) usize {
    return snapshot.storage.bytes.len + snapshot.uid.len + @sizeOf(Replay) + @sizeOf(Entry);
}

fn monitor(self: *Self) std.Io.Cancelable!void {
    var reader = self.stream.reader(self.io, &.{});
    var byte: [1]u8 = undefined;
    reader.interface.readSliceAll(&byte) catch {};
    self.closed.store(true, .release);
    self.ready.set(self.io);
}

pub fn next_response(allocator: std.mem.Allocator, io: std.Io, stream: std.Io.net.Stream) !std.json.Parsed(wire.Response) {
    return frames.response(allocator, io, stream);
}

pub fn exchange(allocator: std.mem.Allocator, io: std.Io, stream: std.Io.net.Stream, request: wire.Request) !std.json.Parsed(wire.Response) {
    var timeout: std.Io.Group = .init;
    try timeout.concurrent(io, frames.watchdog, .{ io, stream });
    defer timeout.cancel(io);
    const bytes = try frames.encode(allocator, request, wire.max_request);
    defer allocator.free(bytes);
    var writer = stream.writer(io, &.{});
    try writer.interface.writeAll(bytes);
    try writer.interface.flush();
    return frames.response(allocator, io, stream);
}
