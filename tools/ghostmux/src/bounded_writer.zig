const std = @import("std");
const Self = @This();

allocator: std.mem.Allocator,
limit: usize,
writer: std.Io.Writer,
failure: ?error{ OutOfMemory, LimitExceeded } = null,

pub fn init(allocator: std.mem.Allocator, limit: usize) Self {
    return .{ .allocator = allocator, .limit = limit, .writer = .{
        .buffer = &.{},
        .vtable = &.{ .drain = drain, .flush = std.Io.Writer.noopFlush, .rebase = rebase },
    } };
}

pub fn deinit(self: *Self) void {
    var storage = self.allocating();
    storage.deinit();
    self.writer.buffer = &.{};
    self.writer.end = 0;
}

pub fn toOwnedSlice(self: *Self) ![]u8 {
    var storage = self.allocating();
    const result = try storage.toOwnedSlice();
    self.writer.buffer = &.{};
    self.writer.end = 0;
    return result;
}

fn allocating(self: *Self) std.Io.Writer.Allocating {
    return .{ .allocator = self.allocator, .writer = self.writer, .alignment = .of(u8) };
}

fn ensure(self: *Self, additional: usize) std.Io.Writer.Error!void {
    const needed = std.math.add(usize, self.writer.end, additional) catch return self.exceeded();
    if (needed > self.limit) return self.exceeded();
    if (needed <= self.writer.buffer.len) return;
    const growth = std.math.add(usize, self.writer.buffer.len, self.writer.buffer.len / 2 + 64) catch self.limit;
    const capacity = @min(self.limit, @max(needed, growth));
    var storage = self.allocating();
    storage.ensureTotalCapacityPrecise(capacity) catch {
        self.failure = error.OutOfMemory;
        return error.WriteFailed;
    };
    self.writer.buffer = storage.writer.buffer;
}

fn exceeded(self: *Self) std.Io.Writer.Error {
    self.failure = error.LimitExceeded;
    return error.WriteFailed;
}

fn drain(writer: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
    const self: *Self = @fieldParentPtr("writer", writer);
    std.debug.assert(data.len > 0);
    const pattern = data[data.len - 1];
    var length = std.math.mul(usize, pattern.len, splat) catch return self.exceeded();
    for (data[0 .. data.len - 1]) |bytes| length = std.math.add(usize, length, bytes.len) catch return self.exceeded();
    try self.ensure(length);
    for (data[0 .. data.len - 1]) |bytes| {
        @memcpy(writer.buffer[writer.end..][0..bytes.len], bytes);
        writer.end += bytes.len;
    }
    if (pattern.len == 1) {
        @memset(writer.buffer[writer.end..][0..splat], pattern[0]);
        writer.end += splat;
    } else if (pattern.len > 0) for (0..splat) |_| {
        @memcpy(writer.buffer[writer.end..][0..pattern.len], pattern);
        writer.end += pattern.len;
    };
    return length;
}

fn rebase(writer: *std.Io.Writer, preserve: usize, minimum: usize) std.Io.Writer.Error!void {
    const self: *Self = @fieldParentPtr("writer", writer);
    std.debug.assert(preserve <= writer.end);
    try self.ensure(minimum);
}
