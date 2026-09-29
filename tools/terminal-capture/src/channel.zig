const std = @import("std");
const c = @import("native.zig").c;
const wire = @import("wire.zig");
const transport = @import("transport.zig");
const Self = @This();

allocator: std.mem.Allocator,
fd: c_int,
deadline: i64,
header: [4]u8 = undefined,
header_read: usize = 0,
body: ?[]u8 = null,
body_read: usize = 0,
output: ?[]u8 = null,
output_sent: usize = 0,

pub fn init(allocator: std.mem.Allocator, fd: c_int) !*Self {
    try transport.nonblocking(fd);
    if (c.fcntl(fd, c.F_SETFD, c.FD_CLOEXEC) < 0) return error.FcntlFailed;
    const self = try allocator.create(Self);
    self.* = .{ .allocator = allocator, .fd = fd, .deadline = transport.now_ms() + wire.timeout_ms };
    return self;
}

pub fn deinit(self: *Self) void {
    _ = c.close(self.fd);
    if (self.body) |body| self.allocator.free(body);
    if (self.output) |output| self.allocator.free(output);
    self.allocator.destroy(self);
}

pub fn events(self: *Self) c_short {
    return if (self.output != null) c.POLLOUT else c.POLLIN;
}

pub fn receive(self: *Self) !?[]const u8 {
    if (self.header_read < 4) {
        self.header_read += try read_some(self.fd, self.header[self.header_read..]);
        if (self.header_read < 4) return null;
    }
    if (self.body == null) {
        const length = std.mem.readInt(u32, &self.header, .big);
        if (length == 0 or length > wire.max_request) return error.InvalidFrameSize;
        self.body = try self.allocator.alloc(u8, length);
    }
    const body = self.body.?;
    const end = @min(body.len, self.body_read + 64 * 1024);
    self.body_read += try read_some(self.fd, body[self.body_read..end]);
    return if (self.body_read == body.len) body else null;
}

pub fn respond(self: *Self, value: wire.Response) !void {
    std.debug.assert(self.output == null);
    const json = try std.json.Stringify.valueAlloc(self.allocator, value, .{ .emit_null_optional_fields = true });
    defer self.allocator.free(json);
    if (json.len > wire.max_response) return error.ResponseTooLarge;
    const output = try self.allocator.alloc(u8, 4 + json.len);
    std.mem.writeInt(u32, output[0..4], @intCast(json.len), .big);
    @memcpy(output[4..], json);
    self.output = output;
    self.deadline = transport.now_ms() + wire.timeout_ms;
    if (self.body) |body| self.allocator.free(body);
    self.body = null;
}

pub fn flush(self: *Self) !bool {
    const output = self.output.?;
    const end = @min(output.len, self.output_sent + 64 * 1024);
    const written = c.send(self.fd, output[self.output_sent..end].ptr, end - self.output_sent, c.MSG_NOSIGNAL);
    if (written < 0) return switch (std.c.errno(written)) {
        .AGAIN, .INTR => false,
        else => error.ConnectionClosed,
    };
    if (written == 0) return error.ConnectionClosed;
    self.output_sent += @intCast(written);
    return self.output_sent == output.len;
}

fn read_some(fd: c_int, target: []u8) !usize {
    if (target.len == 0) return 0;
    const count = c.recv(fd, target.ptr, target.len, 0);
    if (count < 0) return switch (std.c.errno(count)) {
        .AGAIN, .INTR => 0,
        else => error.ConnectionClosed,
    };
    if (count == 0) return error.ConnectionClosed;
    return @intCast(count);
}

pub fn exchange(allocator: std.mem.Allocator, fd: c_int, request: wire.Request) !std.json.Parsed(wire.Response) {
    const json = try std.json.Stringify.valueAlloc(allocator, request, .{});
    defer allocator.free(json);
    if (json.len > wire.max_request) return error.RequestTooLarge;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(json.len), .big);
    try transport.nonblocking(fd);
    const deadline = transport.now_ms() + wire.timeout_ms;
    try transfer(fd, &header, true, deadline);
    try transfer(fd, json, true, deadline);
    try transfer(fd, &header, false, deadline);
    const length = std.mem.readInt(u32, &header, .big);
    if (length == 0 or length > wire.max_response) return error.InvalidFrameSize;
    const body = try allocator.alloc(u8, length);
    defer allocator.free(body);
    try transfer(fd, body, false, deadline);
    const parsed = try std.json.parseFromSlice(wire.Response, allocator, body, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (parsed.value.version != wire.protocol_version) return error.ProtocolVersionMismatch;
    return parsed;
}

fn transfer(fd: c_int, bytes: []u8, write: bool, deadline: i64) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const left = deadline - transport.now_ms();
        if (left <= 0) return error.ServerTimeout;
        var pollfd: c.struct_pollfd = .{ .fd = fd, .events = if (write) c.POLLOUT else c.POLLIN, .revents = 0 };
        const ready = c.poll(&pollfd, 1, @intCast(left));
        if (ready < 0) {
            if (std.c.errno(ready) == .INTR) continue;
            return error.PollFailed;
        }
        if (ready == 0) return error.ServerTimeout;
        const count = if (write) c.send(fd, bytes[offset..].ptr, bytes.len - offset, c.MSG_NOSIGNAL) else c.recv(fd, bytes[offset..].ptr, bytes.len - offset, 0);
        if (count < 0) {
            switch (std.c.errno(count)) {
                .INTR, .AGAIN => continue,
                else => return error.ConnectionClosed,
            }
        }
        if (count == 0) return error.ConnectionClosed;
        offset += @intCast(count);
    }
}
