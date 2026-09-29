const std = @import("std");
const builtin = @import("builtin");
const security = @import("runtime_security.zig");
const windows = builtin.os.tag == .windows;
const Dir = std.Io.Dir;
const File = std.Io.File;
const socket_path_limit = if (windows) std.Io.net.UnixAddress.max_len else @sizeOf(@FieldType(std.posix.sockaddr.un, "path"));

pub fn safe_directory(allocator: std.mem.Allocator, io: std.Io, path: []const u8, private: bool) !void {
    const named = try Dir.cwd().statFile(io, path, .{ .follow_symlinks = false });
    if (named.kind != .directory) return error.UnsafeSocketDirectory;
    if (windows) return @import("runtime_windows_security.zig").check(allocator, path);
    var directory = try Dir.cwd().openDir(io, path, .{ .follow_symlinks = false });
    defer directory.close(io);
    const info = try directory.stat(io);
    if (info.inode != named.inode) return error.UnsafeSocketDirectory;
    const owner_uid = try security.file_owner(.{ .handle = directory.handle, .flags = .{ .nonblocking = false } });
    const mode = info.permissions.toMode();
    if (private) {
        if (owner_uid != security.uid() or mode & 0o077 != 0) return error.UnsafeSocketDirectory;
    } else {
        const sticky_root = owner_uid == 0 and mode & std.posix.S.ISVTX != 0;
        if ((owner_uid != 0 and owner_uid != security.uid()) or (mode & 0o022 != 0 and !sticky_root)) return error.UnsafeSocketDirectory;
    }
}

pub fn check_directory(allocator: std.mem.Allocator, io: std.Io, path: []const u8, private: bool) !void {
    if (!std.fs.path.isAbsolute(path) or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidSocketPath;
    if (!windows) {
        var components = std.mem.splitScalar(u8, path[1..], '/');
        while (components.next()) |component| {
            if (std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, "..")) return error.InvalidSocketPath;
        }
        try safe_directory(allocator, io, "/", false);
        for (path[1..], 1..) |byte, offset| {
            if (byte == '/') try safe_directory(allocator, io, path[0..offset], false);
        }
    }
    try safe_directory(allocator, io, path, private);
}

pub fn check_parent(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !void {
    if (!std.fs.path.isAbsolute(path) or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidSocketPath;
    if (!windows and path.len >= socket_path_limit) return error.SocketPathTooLong;
    _ = try std.Io.net.UnixAddress.init(path);
    const parent = std.fs.path.dirname(path) orelse return error.InvalidSocketPath;
    try check_directory(allocator, io, parent, true);
}

pub fn canonical_path(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![:0]u8 {
    if (!std.fs.path.isAbsolute(path) or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidSocketPath;
    if (builtin.os.tag == .macos) {
        for ([_][:0]const u8{ "/var", "/tmp" }) |alias| {
            if (!std.mem.startsWith(u8, path, alias) or (path.len != alias.len and path[alias.len] != '/')) continue;
            const before = try Dir.cwd().statFile(io, alias, .{ .follow_symlinks = false });
            if (before.kind != .sym_link) break;
            try safe_directory(allocator, io, "/", false);
            if (try security.owner("/") != 0 or try security.owner(alias) != 0) return error.UnsafeSocketDirectory;
            const root = try Dir.cwd().statFile(io, "/", .{ .follow_symlinks = false });
            if (root.permissions.toMode() & 0o022 != 0) return error.UnsafeSocketDirectory;
            var buffer: [64]u8 = undefined;
            const target = buffer[0..try Dir.cwd().readLink(io, alias, &buffer)];
            var expected_buffer: [32]u8 = undefined;
            const expected = try std.fmt.bufPrint(&expected_buffer, "/private{s}", .{alias});
            if (!std.mem.eql(u8, target, expected) and !std.mem.eql(u8, target, expected[1..])) return error.UnsafeSocketDirectory;
            const after = try Dir.cwd().statFile(io, alias, .{ .follow_symlinks = false });
            if (after.kind != .sym_link or after.inode != before.inode) return error.UnsafeSocketDirectory;
            return std.fmt.allocPrintSentinel(allocator, "{s}{s}", .{ expected, path[alias.len..] }, 0);
        }
    }
    return allocator.dupeZ(u8, path);
}
