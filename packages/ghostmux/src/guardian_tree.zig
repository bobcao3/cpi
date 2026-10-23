const std = @import("std");
const linux = std.os.linux;
const Dir = std.Io.Dir;
const security = @import("runtime_security.zig");

pub const Identity = struct {
    inode: u64,
    device_major: u32,
    device_minor: u32,
    mount_id: u64,
    birth_seconds: i64,
    birth_nanoseconds: u32,

    pub fn eql(a: Identity, b: Identity) bool {
        return std.meta.eql(a, b);
    }
};

pub fn identity(dir: Dir) !Identity {
    var stat: linux.Statx = std.mem.zeroes(linux.Statx);
    if (linux.errno(linux.statx(dir.handle, "", linux.AT.EMPTY_PATH, .{ .INO = true, .TYPE = true, .BTIME = true, .MNT_ID = true }, &stat)) != .SUCCESS or !stat.mask.INO or !stat.mask.TYPE or !stat.mask.BTIME or !stat.mask.MNT_ID) return error.IdentityUnavailable;
    if (stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR) return error.NotDirectory;
    return .{ .inode = stat.ino, .device_major = stat.dev_major, .device_minor = stat.dev_minor, .mount_id = stat.mnt_id, .birth_seconds = stat.btime.sec, .birth_nanoseconds = stat.btime.nsec };
}

pub fn sync(dir: Dir, io: std.Io) !void {
    try (std.Io.File{ .handle = dir.handle, .flags = .{ .nonblocking = false } }).sync(io);
}

pub fn private_dir(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !Dir {
    if (path.len == 0 or path.len > 4096 or path[path.len - 1] == '/') return error.InvalidDirectory;
    try @import("socket_directory.zig").check_directory(allocator, io, path, true);
    var dir = try Dir.cwd().openDir(io, path, .{ .iterate = true, .follow_symlinks = false });
    errdefer dir.close(io);
    const canonical = try dir.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(canonical);
    if (!std.mem.eql(u8, canonical, path)) return error.NonCanonicalDirectory;
    const stat = try dir.stat(io);
    if (stat.permissions.toMode() & 0o077 != 0 or try security.file_owner(.{ .handle = dir.handle, .flags = .{ .nonblocking = false } }) != security.uid()) return error.UnsafeDirectory;
    return dir;
}

fn open_matching(io: std.Io, parent: Dir, name: []const u8, expected: Identity) !Dir {
    var dir = try parent.openDir(io, name, .{ .iterate = true, .follow_symlinks = false });
    errdefer dir.close(io);
    if (!expected.eql(try identity(dir))) return error.IdentityMismatch;
    return dir;
}

pub fn remove(io: std.Io, root: Dir, name: []const u8, expected: Identity) !void {
    const Frame = struct { dir: Dir, iterator: Dir.Iterator, name: [256]u8, length: usize, id: Identity };
    var frames: [32]Frame = undefined;
    var depth: usize = 0;
    defer while (depth > 0) {
        depth -= 1;
        frames[depth].dir.close(io);
    };
    const first = open_matching(io, root, name, expected) catch |err| switch (err) {
        error.FileNotFound => return error.ScopeMissing,
        else => return err,
    };
    frames[0] = .{ .dir = first, .iterator = first.iterate(), .name = undefined, .length = name.len, .id = expected };
    @memcpy(frames[0].name[0..name.len], name);
    depth = 1;
    var entries: usize = 0;
    while (depth > 0) {
        const frame = &frames[depth - 1];
        if (try frame.iterator.next(io)) |entry| {
            entries += 1;
            if (entries > 10000 or entry.name.len > 255) return error.CleanupLimit;
            const stat = frame.dir.statFile(io, entry.name, .{ .follow_symlinks = false }) catch |err| switch (err) {
                error.FileNotFound => continue,
                else => return err,
            };
            if (stat.kind != .directory) {
                try frame.dir.deleteFile(io, entry.name);
                continue;
            }
            if (depth == frames.len) return error.CleanupDepth;
            var child = try frame.dir.openDir(io, entry.name, .{ .iterate = true, .follow_symlinks = false });
            errdefer child.close(io);
            const id = try identity(child);
            if (id.inode != stat.inode or id.device_major != expected.device_major or id.device_minor != expected.device_minor or id.mount_id != expected.mount_id) return error.IdentityMismatch;
            frames[depth] = .{ .dir = child, .iterator = child.iterate(), .name = undefined, .length = entry.name.len, .id = id };
            @memcpy(frames[depth].name[0..entry.name.len], entry.name);
            depth += 1;
        } else {
            const parent = if (depth == 1) root else frames[depth - 2].dir;
            const child_name = frame.name[0..frame.length];
            var checked = try open_matching(io, parent, child_name, frame.id);
            checked.close(io);
            try parent.deleteDir(io, child_name);
            frame.dir.close(io);
            depth -= 1;
        }
    }
    try sync(root, io);
}
