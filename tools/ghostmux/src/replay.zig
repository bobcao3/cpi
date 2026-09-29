const std = @import("std");
const wire = @import("wire.zig");
const Output = @import("output.zig");
const frames = @import("runtime_frames.zig");
const Self = @This();

allocator: std.mem.Allocator,
uid: []u8,
storage: *@import("output_storage.zig"),
offset: u64,
end: u64,

pub fn snapshot(allocator: std.mem.Allocator, uid: []const u8, output: *const Output, offset: u64) !*Self {
    if (offset < output.first()) return error.OutputExpired;
    if (offset > output.end) return error.InvalidOffset;
    const self = try allocator.create(Self);
    errdefer allocator.destroy(self);
    const name = try allocator.dupe(u8, uid);
    errdefer allocator.free(name);
    output.storage.retain();
    self.* = .{ .allocator = allocator, .uid = name, .storage = output.storage, .offset = offset, .end = output.end };
    return self;
}

pub fn next(self: *Self) !*frames.Shared {
    std.debug.assert(self.offset < self.end);
    const length: usize = @intCast(@min(wire.max_output_chunk, self.end - self.offset));
    var scratch: [std.base64.standard.Encoder.calcSize(wire.max_output_chunk)]u8 = undefined;
    const encoded = Output.encode_range_into(&scratch, self.storage, self.offset, length);
    const frame = try frames.Shared.create(self.allocator, .{ .server_pid = wire.process_id(), .event = "data", .uid = self.uid, .offset = self.offset, .next_offset = self.offset + length, .base64 = encoded });
    self.offset += length;
    return frame;
}

pub fn deinit(self: *Self) void {
    self.allocator.free(self.uid);
    self.storage.release();
    self.allocator.destroy(self);
}
