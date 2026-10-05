const std = @import("std");
const wire = @import("wire.zig");
const Self = @This();
const Storage = @import("output_storage.zig");
pub const capacity = Storage.capacity;
const max_log = 64 * 1024 * 1024;
allocator: std.mem.Allocator,
io: std.Io,
storage: *Storage,
end: u64 = 0,
log: ?std.Io.File = null,

pub fn init(allocator: std.mem.Allocator, io: std.Io, path: ?[]const u8) !Self {
    const storage = try Storage.create(allocator);
    errdefer storage.release();
    var self: Self = .{ .allocator = allocator, .io = io, .storage = storage };
    if (path) |name| {
        if (!std.fs.path.isAbsolute(name)) return error.ExpectedAbsolutePath;
        self.log = try std.Io.Dir.createFileAbsolute(io, name, .{ .exclusive = true });
    }
    return self;
}
pub fn deinit(self: *Self) void {
    if (self.log) |file| file.close(self.io);
    self.storage.release();
}
pub fn append(self: *Self, data: []const u8) !void {
    std.debug.assert(data.len <= capacity);
    const end = std.math.add(u64, self.end, data.len) catch return error.OutputTooLarge;
    if (self.log != null and end > max_log) return error.LogLimit;
    self.storage = try self.storage.writable(@intCast(@min(self.end, capacity)));
    if (self.log) |file| try file.writeStreamingAll(self.io, data);
    const start: usize = @intCast(self.end % capacity);
    const length = @min(data.len, capacity - start);
    @memcpy(self.storage.bytes[start..][0..length], data[0..length]);
    @memcpy(self.storage.bytes[0 .. data.len - length], data[length..]);
    self.end = end;
}
pub fn first(self: *const Self) u64 {
    return self.end -| capacity;
}
pub fn read(self: *const Self, allocator: std.mem.Allocator, offset: u64, limit: u32) !wire.Response {
    if (limit == 0 or limit > wire.max_output_chunk) return error.InvalidReadLimit;
    if (offset < self.first()) return error.OutputExpired;
    if (offset > self.end) return error.InvalidOffset;
    const length: usize = @intCast(@min(self.end - offset, limit));
    return .{ .server_pid = 0, .offset = offset, .next_offset = offset + length, .base64 = try encode_range(allocator, self.storage, offset, length) };
}

pub fn encode_range(allocator: std.mem.Allocator, storage: *const Storage, offset: u64, length: usize) ![]u8 {
    std.debug.assert(length <= wire.max_output_chunk);
    const encoder = std.base64.standard.Encoder;
    const encoded = try allocator.alloc(u8, encoder.calcSize(length));
    _ = encode_range_into(encoded, storage, offset, length);
    return encoded;
}

pub fn encode_range_into(buffer: []u8, storage: *const Storage, offset: u64, length: usize) []const u8 {
    std.debug.assert(length <= wire.max_output_chunk);
    const encoder = std.base64.standard.Encoder;
    const encoded = buffer[0..encoder.calcSize(length)];
    const start: usize = @intCast(offset % capacity);
    const first_length = @min(length, capacity - start);
    if (first_length == length) {
        _ = encoder.encode(encoded, storage.bytes[start..][0..length]);
    } else {
        const prefix = first_length - first_length % 3;
        var written = encoder.calcSize(prefix);
        _ = encoder.encode(encoded[0..written], storage.bytes[start..][0..prefix]);
        var consumed: usize = 0;
        if (prefix != first_length) {
            var crossing: [3]u8 = undefined;
            const tail = first_length - prefix;
            consumed = @min(3 - tail, length - first_length);
            @memcpy(crossing[0..tail], storage.bytes[start + prefix ..][0..tail]);
            @memcpy(crossing[tail..][0..consumed], storage.bytes[0..consumed]);
            const count = encoder.calcSize(tail + consumed);
            _ = encoder.encode(encoded[written..][0..count], crossing[0 .. tail + consumed]);
            written += count;
        }
        _ = encoder.encode(encoded[written..], storage.bytes[consumed .. length - first_length]);
    }
    return encoded;
}
