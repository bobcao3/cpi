const std = @import("std");
const wire = @import("wire.zig");
const Self = @This();

path: []const u8,
temporary: []const u8,
published: bool = false,
finished: bool = false,

pub fn init(arena_allocator: std.mem.Allocator, io: std.Io, path: []const u8) !Self {
    if (!std.fs.path.isAbsolute(path)) return error.ExpectedAbsolutePath;
    if (path.len > 4096 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidStatusPath;
    var random: [16]u8 = undefined;
    try io.randomSecure(&random);
    const temporary_name = try std.fmt.allocPrint(arena_allocator, ".ghostmux-status-{s}.tmp", .{std.fmt.bytesToHex(random, .lower)});
    const temporary = try std.fs.path.join(arena_allocator, &.{ std.fs.path.dirname(path).?, temporary_name });
    const name = try arena_allocator.dupe(u8, path);
    const file = try std.Io.Dir.createFileAbsolute(io, name, .{ .exclusive = true, .permissions = permissions() });
    file.close(io);
    return .{ .path = name, .temporary = temporary };
}

pub fn write(self: *Self, io: std.Io, status: wire.Status, failure: ?anyerror) !void {
    if (self.finished) return;
    const Record = struct { session: wire.Status, ok: bool = true, server_pid: i32, error_name: ?[]const u8 };
    var bytes: [4096]u8 = undefined;
    var writer = std.Io.Writer.fixed(&bytes);
    try std.json.Stringify.value(Record{ .session = status, .server_pid = wire.process_id(), .error_name = if (failure) |err| @errorName(err) else null }, .{}, &writer);
    try writer.writeByte('\n');
    const file = try std.Io.Dir.createFileAbsolute(io, self.temporary, .{ .exclusive = true, .permissions = permissions() });
    var open = true;
    defer if (open) file.close(io);
    errdefer {
        if (open) {
            file.close(io);
            open = false;
        }
        std.Io.Dir.deleteFileAbsolute(io, self.temporary) catch |err| std.log.err("status temporary cleanup failed: {s}", .{@errorName(err)});
    }
    try file.writeStreamingAll(io, writer.buffered());
    file.close(io);
    open = false;
    try std.Io.Dir.renameAbsolute(self.temporary, self.path, io);
    self.published = true;
    self.finished = status.exit_code != null;
}

pub fn deinit(self: *Self, io: std.Io) void {
    if (!self.published) std.Io.Dir.deleteFileAbsolute(io, self.path) catch |err| std.log.err("status reservation cleanup failed: {s}", .{@errorName(err)});
}

fn permissions() std.Io.File.Permissions {
    return if (@import("builtin").os.tag == .windows) .default_file else .fromMode(0o600);
}
