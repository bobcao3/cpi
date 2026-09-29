const std = @import("std");
const Self = @This();
pub const capacity = 1024 * 1024;

allocator: std.mem.Allocator,
bytes: []u8,
references: std.atomic.Value(usize) = .init(1),

pub fn create(allocator: std.mem.Allocator) !*Self {
    const self = try allocator.create(Self);
    errdefer allocator.destroy(self);
    self.* = .{ .allocator = allocator, .bytes = try allocator.alloc(u8, capacity) };
    return self;
}

pub fn writable(self: *Self, initialized: usize) !*Self {
    std.debug.assert(initialized <= capacity);
    if (self.references.load(.acquire) == 1) return self;
    const copy = try create(self.allocator);
    @memcpy(copy.bytes[0..initialized], self.bytes[0..initialized]);
    self.release();
    return copy;
}

pub fn retain(self: *Self) void {
    const previous = self.references.fetchAdd(1, .monotonic);
    std.debug.assert(previous > 0 and previous < std.math.maxInt(usize));
}

pub fn release(self: *Self) void {
    const previous = self.references.fetchSub(1, .acq_rel);
    std.debug.assert(previous > 0);
    if (previous != 1) return;
    self.allocator.free(self.bytes);
    self.allocator.destroy(self);
}
