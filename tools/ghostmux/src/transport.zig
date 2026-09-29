const std = @import("std");
const builtin = @import("builtin");
const wire = @import("wire.zig");
const security = @import("runtime_security.zig");
const directory_security = @import("socket_directory.zig");
const safe_directory = directory_security.safe_directory;
const check_parent = directory_security.check_parent;
const windows = builtin.os.tag == .windows;
const Dir = std.Io.Dir;
const File = std.Io.File;
const connect_timeout_ms = 250;
const socket_path_limit = if (windows) std.Io.net.UnixAddress.max_len else @sizeOf(@FieldType(std.posix.sockaddr.un, "path"));

pub fn now_ms(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}

fn permissions(mode: u16) File.Permissions {
    return if (windows) .default_file else .fromMode(mode);
}

fn stat(io: std.Io, path: []const u8) !?File.Stat {
    return Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}

pub fn socket_path(allocator: std.mem.Allocator, io: std.Io, environ: *const std.process.Environ.Map, explicit: ?[]const u8) ![:0]u8 {
    if (explicit) |path| {
        const canonical = try directory_security.canonical_path(allocator, io, path);
        errdefer allocator.free(canonical);
        try check_parent(allocator, io, canonical);
        return canonical;
    }
    const requested_directory = if (windows)
        try std.fs.path.join(allocator, &.{ environ.get("LOCALAPPDATA") orelse return error.MissingLocalAppData, "ghostmux" })
    else blk: {
        if (environ.get("XDG_RUNTIME_DIR")) |base| {
            if (std.fs.path.isAbsolute(base)) {
                if (directory_security.canonical_path(allocator, io, base)) |canonical_base| {
                    defer allocator.free(canonical_base);
                    if (directory_security.check_directory(allocator, io, canonical_base, true)) |_| {
                        const candidate = try std.fmt.allocPrint(allocator, "{s}/ghostmux-{d}", .{ canonical_base, security.uid() });
                        if (candidate.len + "/default.sock".len < socket_path_limit) break :blk candidate;
                        allocator.free(candidate);
                    } else |_| {}
                } else |_| {}
            }
        }
        break :blk try std.fmt.allocPrint(allocator, "/tmp/ghostmux-{d}", .{security.uid()});
    };
    defer allocator.free(requested_directory);
    const directory = try directory_security.canonical_path(allocator, io, requested_directory);
    defer allocator.free(directory);
    if (!windows) try directory_security.check_directory(allocator, io, std.fs.path.dirname(directory) orelse return error.InvalidSocketPath, false);
    if (windows) {
        try @import("runtime_windows_security.zig").create(allocator, directory);
    } else Dir.cwd().createDir(io, directory, permissions(0o700)) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    try safe_directory(allocator, io, directory, true);
    const path = try std.fs.path.join(allocator, &.{ directory, "default.sock" });
    defer allocator.free(path);
    try check_parent(allocator, io, path);
    return allocator.dupeZ(u8, path);
}

fn socket_stat(io: std.Io, path: [:0]const u8) !?File.Stat {
    const info = (try stat(io, path)) orelse return null;
    if (windows) {
        if (!try @import("runtime_windows_security.zig").is_socket(io, path)) return error.UnsafeSocket;
    } else {
        if (info.kind != .unix_domain_socket or (try security.owner(path)) != security.uid()) return error.UnsafeSocket;
    }
    return info;
}

fn connect_once(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8) !std.Io.net.Stream {
    try check_parent(allocator, io, path);
    _ = (try socket_stat(io, path)) orelse return error.SocketMissing;
    const address = try std.Io.net.UnixAddress.init(path);
    const stream = try connect_bounded(io, &address);
    errdefer stream.close(io);
    try security.peer(stream);
    return stream;
}

fn connect_delay(io: std.Io) std.Io.Cancelable!void {
    try std.Io.sleep(io, .fromMilliseconds(connect_timeout_ms), .awake);
}

fn connect_bounded(io: std.Io, address: *const std.Io.net.UnixAddress) !std.Io.net.Stream {
    const Result = union(enum) { connection: anyerror!std.Io.net.Stream, timeout: std.Io.Cancelable!void };
    var results: [2]Result = undefined;
    var select = std.Io.Select(Result).init(io, &results);
    defer while (select.cancel()) |result| {
        switch (result) {
            .connection => |connection| if (connection) |stream| stream.close(io) else |_| {},
            .timeout => {},
        }
    };
    try select.concurrent(.connection, std.Io.net.UnixAddress.connect, .{ address, io });
    try select.concurrent(.timeout, connect_delay, .{io});
    return switch (try select.await()) {
        .connection => |connection| connection,
        .timeout => error.ServerBusy,
    };
}

pub fn open_lock(allocator: std.mem.Allocator, io: std.Io, path: []const u8, suffix: []const u8) !File {
    const lock_path = try std.fmt.allocPrint(allocator, "{s}{s}", .{ path, suffix });
    defer allocator.free(lock_path);
    const file = Dir.cwd().createFile(io, lock_path, .{ .read = true, .truncate = false, .exclusive = true, .permissions = permissions(0o600) }) catch |err| switch (err) {
        error.PathAlreadyExists => try Dir.cwd().openFile(io, lock_path, .{ .mode = .read_write, .follow_symlinks = false }),
        else => return err,
    };
    errdefer file.close(io);
    const info = try file.stat(io);
    const named = (try stat(io, lock_path)) orelse return error.UnsafeLock;
    if (info.kind != .file or named.kind != .file or info.inode != named.inode or info.nlink != 1) return error.UnsafeLock;
    if (!windows and (info.permissions.toMode() & 0o077 != 0 or try security.file_owner(file) != security.uid())) return error.UnsafeLock;
    return file;
}

fn startable(err: anyerror) bool {
    return err == error.SocketMissing or err == error.FileNotFound or err == error.Unexpected or err == error.ConnectionRefused;
}

pub fn lock_startup(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8) !File {
    const startup = try open_lock(allocator, io, path, ".startup");
    errdefer startup.close(io);
    const deadline = now_ms(io) + wire.timeout_ms;
    while (!try startup.tryLock(io, .exclusive)) {
        if (now_ms(io) >= deadline) return error.StartupTimeout;
        try std.Io.sleep(io, .fromMilliseconds(20), .awake);
    }
    return startup;
}

// Assume the caller holds the startup lock until the first response arrives.
pub fn connect_or_start(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8, can_start: bool) !std.Io.net.Stream {
    return connect_once(allocator, io, path) catch |initial| {
        if (!can_start or !startable(initial)) return initial;
        const deadline = now_ms(io) + wire.timeout_ms;
        const guard = try open_lock(allocator, io, path, ".lock");
        if (!try guard.tryLock(io, .exclusive)) {
            guard.close(io);
            return error.ServerBusy;
        }
        guard.close(io);
        const executable = try std.process.executablePathAlloc(io, allocator);
        defer allocator.free(executable);
        const child = try std.process.spawn(io, .{ .argv = &.{ executable, "--serve", path }, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore, .create_no_window = windows });
        if (windows) {
            std.os.windows.CloseHandle(child.id.?);
            std.os.windows.CloseHandle(child.thread_handle);
        }
        while (now_ms(io) < deadline) {
            if (connect_once(allocator, io, path)) |stream| return stream else |err| if (!startable(err)) return err;
            try std.Io.sleep(io, .fromMilliseconds(20), .awake);
        }
        return error.StartupTimeout;
    };
}

pub const Listener = struct {
    server: std.Io.net.Server,
    lock: File,
    startup: File,
    inode: File.INode,

    pub fn cleanup(self: *Listener, io: std.Io, path: [:0]const u8) void {
        self.server.deinit(io);
        if (socket_stat(io, path) catch null) |info| {
            if (info.inode == self.inode) Dir.cwd().deleteFile(io, path) catch {};
        }
        self.lock.close(io);
        self.startup.close(io);
    }
};

pub fn listen(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8) !Listener {
    try check_parent(allocator, io, path);
    const startup = try open_lock(allocator, io, path, ".startup");
    errdefer startup.close(io);
    const lock = try open_lock(allocator, io, path, ".lock");
    errdefer lock.close(io);
    if (!try lock.tryLock(io, .exclusive)) return error.ServerBusy;
    if (try socket_stat(io, path)) |_| {
        if (connect_once(allocator, io, path)) |stream| {
            stream.close(io);
            return error.ServerAlreadyRunning;
        } else |err| if (!startable(err)) return err;
        try Dir.cwd().deleteFile(io, path);
    }
    const address = try std.Io.net.UnixAddress.init(path);
    var server = try address.listen(io, .{});
    errdefer server.deinit(io);
    errdefer Dir.cwd().deleteFile(io, path) catch {};
    if (!windows) try Dir.cwd().setFilePermissions(io, path, permissions(0o600), .{ .follow_symlinks = false });
    const info = (try socket_stat(io, path)) orelse return error.SocketMissing;
    return .{ .server = server, .lock = lock, .startup = startup, .inode = info.inode };
}
