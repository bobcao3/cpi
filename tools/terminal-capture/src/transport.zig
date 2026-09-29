const std = @import("std");
const builtin = @import("builtin");
const c = @import("native.zig").c;
const wire = @import("wire.zig");

comptime {
    if (builtin.os.tag != .linux) @compileError("terminal-capture socket transport currently requires Linux");
}

const sockaddr_limit = @sizeOf(@FieldType(c.struct_sockaddr_un, "sun_path"));
var bound_inode: c.ino_t = 0;
var bound_device: c.dev_t = 0;

fn errno_value() c_int {
    return c.__errno_location().*;
}

pub fn now_ms() i64 {
    var time: c.struct_timespec = undefined;
    std.debug.assert(c.clock_gettime(c.CLOCK_MONOTONIC, &time) == 0);
    return @as(i64, @intCast(time.tv_sec)) * 1000 + @divTrunc(@as(i64, @intCast(time.tv_nsec)), 1_000_000);
}

pub fn nonblocking(fd: c_int) !void {
    const flags = c.fcntl(fd, c.F_GETFL);
    if (flags < 0 or c.fcntl(fd, c.F_SETFL, flags | c.O_NONBLOCK) < 0) return error.FcntlFailed;
}

fn parent_path(path: []const u8) ![]const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, path, '/') orelse return error.AbsolutePathRequired;
    if (slash == 0 or slash + 1 == path.len or path[0] != '/' or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidSocketPath;
    return path[0..slash];
}

fn check_length(path: []const u8) !void {
    if (path.len >= sockaddr_limit) return error.SocketPathTooLong;
    _ = try parent_path(path);
}

fn safe_directory(directory: [:0]const u8) !void {
    var stat: c.struct_stat = undefined;
    if (c.lstat(directory.ptr, &stat) != 0) return error.DirectoryStatFailed;
    if (stat.st_mode & c.S_IFMT != c.S_IFDIR or stat.st_uid != c.geteuid() or stat.st_mode & 0o077 != 0) return error.UnsafeSocketDirectory;
    const fd = c.open(directory.ptr, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW | c.O_CLOEXEC);
    if (fd < 0) return error.UnsafeSocketDirectory;
    defer _ = c.close(fd);
    var opened: c.struct_stat = undefined;
    if (c.fstat(fd, &opened) != 0 or opened.st_ino != stat.st_ino or opened.st_dev != stat.st_dev) return error.UnsafeSocketDirectory;
}

fn check_parent(path: [:0]const u8) !void {
    const parent = try parent_path(path);
    var buffer: [sockaddr_limit]u8 = undefined;
    @memcpy(buffer[0..parent.len], parent);
    buffer[parent.len] = 0;
    for (parent[1..], 1..) |byte, offset| {
        if (byte != '/') continue;
        buffer[offset] = 0;
        var stat: c.struct_stat = undefined;
        if (c.lstat(@ptrCast(&buffer), &stat) != 0 or stat.st_mode & c.S_IFMT != c.S_IFDIR) return error.UnsafeSocketDirectory;
        const sticky_root = stat.st_uid == 0 and stat.st_mode & c.S_ISVTX != 0;
        if (stat.st_uid != c.geteuid() and stat.st_uid != 0 or (stat.st_mode & 0o022 != 0 and !sticky_root)) return error.UnsafeSocketDirectory;
        buffer[offset] = '/';
    }
    try safe_directory(buffer[0..parent.len :0]);
}

fn socket_stat(path: [:0]const u8) !?c.struct_stat {
    var stat: c.struct_stat = undefined;
    if (c.lstat(path.ptr, &stat) != 0) {
        if (errno_value() == c.ENOENT) return null;
        return error.SocketStatFailed;
    }
    if (stat.st_mode & c.S_IFMT != c.S_IFSOCK or stat.st_uid != c.geteuid()) return error.UnsafeSocket;
    return stat;
}

fn default_directory(allocator: std.mem.Allocator) ![:0]u8 {
    const runtime = if (c.getenv("XDG_RUNTIME_DIR")) |value| std.mem.span(value) else null;
    if (runtime) |base| {
        if (base.len > 0 and base[0] == '/' and base.len < sockaddr_limit) {
            const base_z = try allocator.dupeZ(u8, base);
            defer allocator.free(base_z);
            if (safe_directory(base_z)) |_| {
                const directory = try std.fmt.allocPrintSentinel(allocator, "{s}/terminal-capture-{d}", .{ base, c.geteuid() }, 0);
                if (directory.len + "/default.sock".len < sockaddr_limit) return directory;
                allocator.free(directory);
            } else |_| {}
        }
    }
    return std.fmt.allocPrintSentinel(allocator, "/tmp/terminal-capture-{d}", .{c.geteuid()}, 0);
}

pub fn socket_path(allocator: std.mem.Allocator, explicit: ?[]const u8) ![:0]u8 {
    if (explicit) |path| {
        try check_length(path);
        const result = try allocator.dupeZ(u8, path);
        errdefer allocator.free(result);
        try check_parent(result);
        return result;
    }
    const directory = try default_directory(allocator);
    defer allocator.free(directory);
    if (c.mkdir(directory.ptr, 0o700) != 0 and errno_value() != c.EEXIST) return error.DirectoryCreateFailed;
    try safe_directory(directory);
    const path = try std.fmt.allocPrintSentinel(allocator, "{s}/default.sock", .{directory}, 0);
    errdefer allocator.free(path);
    try check_length(path);
    try check_parent(path);
    return path;
}

fn address(path: [:0]const u8) !c.struct_sockaddr_un {
    try check_length(path);
    var addr: c.struct_sockaddr_un = std.mem.zeroes(c.struct_sockaddr_un);
    addr.sun_family = c.AF_UNIX;
    @memcpy(std.mem.asBytes(&addr.sun_path)[0 .. path.len + 1], path[0 .. path.len + 1]);
    return addr;
}

fn connect_once(path: [:0]const u8, deadline: i64) !c_int {
    try check_parent(path);
    _ = try socket_stat(path);
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM | c.SOCK_CLOEXEC | c.SOCK_NONBLOCK, 0);
    if (fd < 0) return error.SocketCreateFailed;
    errdefer _ = c.close(fd);
    var addr = try address(path);
    if (c.connect(fd, .{ .__sockaddr_un__ = &addr }, @sizeOf(c.struct_sockaddr_un)) != 0) {
        return switch (errno_value()) {
            c.ENOENT => error.SocketMissing,
            c.ECONNREFUSED => error.ConnectionRefused,
            c.EAGAIN => error.ServerBusy,
            else => error.ConnectFailed,
        };
    }
    if (now_ms() >= deadline) return error.StartupTimeout;
    return fd;
}

fn startup_lock(allocator: std.mem.Allocator, path: [:0]const u8, deadline: i64) !c_int {
    const lock_path = try std.fmt.allocPrintSentinel(allocator, "{s}.lock", .{path}, 0);
    defer allocator.free(lock_path);
    const fd = c.open(lock_path.ptr, c.O_CREAT | c.O_RDWR | c.O_NOFOLLOW | c.O_CLOEXEC, @as(c_uint, 0o600));
    if (fd < 0) return error.LockOpenFailed;
    errdefer _ = c.close(fd);
    var stat: c.struct_stat = undefined;
    if (c.fstat(fd, &stat) != 0 or stat.st_mode & c.S_IFMT != c.S_IFREG or stat.st_uid != c.geteuid() or stat.st_mode & 0o077 != 0 or stat.st_nlink != 1) return error.UnsafeLock;
    while (c.flock(fd, c.LOCK_EX | c.LOCK_NB) != 0) {
        if (errno_value() != c.EWOULDBLOCK and errno_value() != c.EINTR) return error.LockFailed;
        const remaining = deadline - now_ms();
        if (remaining <= 0) return error.StartupTimeout;
        _ = c.poll(null, 0, @intCast(@min(remaining, 20)));
    }
    return fd;
}

fn inheritable(fd: c_int) bool {
    const flags = c.fcntl(fd, c.F_GETFD);
    return flags >= 0 and c.fcntl(fd, c.F_SETFD, flags & ~@as(c_int, c.FD_CLOEXEC)) == 0;
}

fn fail_spawn(status_fd: c_int) noreturn {
    const failed: [1]u8 = .{1};
    _ = c.write(status_fd, &failed, 1);
    c._exit(127);
}

fn above_stdio(fd: c_int) !c_int {
    if (fd >= 3) return fd;
    const duplicate = c.fcntl(fd, c.F_DUPFD_CLOEXEC, @as(c_int, 3));
    if (duplicate < 0) return error.FcntlFailed;
    _ = c.close(fd);
    return duplicate;
}

fn spawn(path: [:0]const u8, lock_fd: c_int, deadline: i64) !c_int {
    var pair: [2]c_int = undefined;
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM | c.SOCK_CLOEXEC, 0, &pair) != 0) return error.SocketPairFailed;
    errdefer _ = c.close(pair[0]);
    defer _ = c.close(pair[1]);
    pair[1] = try above_stdio(pair[1]);
    var status_pipe: [2]c_int = undefined;
    if (c.pipe2(&status_pipe, c.O_CLOEXEC) != 0) return error.PipeFailed;
    defer _ = c.close(status_pipe[0]);
    defer _ = c.close(status_pipe[1]);
    status_pipe[1] = try above_stdio(status_pipe[1]);
    const inherited_lock = c.fcntl(lock_fd, c.F_DUPFD_CLOEXEC, @as(c_int, 3));
    if (inherited_lock < 0) return error.FcntlFailed;
    defer _ = c.close(inherited_lock);
    var child_text: [32]u8 = undefined;
    var lock_text: [32]u8 = undefined;
    const child_arg = try std.fmt.bufPrintZ(&child_text, "{d}", .{pair[1]});
    const lock_arg = try std.fmt.bufPrintZ(&lock_text, "{d}", .{inherited_lock});
    const serve: [:0]const u8 = "--serve";
    const executable: [:0]const u8 = "/proc/self/exe";
    const argv = [_:null]?[*:0]const u8{ executable.ptr, serve.ptr, path.ptr, child_arg.ptr, lock_arg.ptr };
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = c.close(pair[0]);
        _ = c.close(status_pipe[0]);
        if (c.setsid() < 0) fail_spawn(status_pipe[1]);
        const grandchild = c.fork();
        if (grandchild < 0) fail_spawn(status_pipe[1]);
        if (grandchild > 0) c._exit(0);
        const null_fd = c.open("/dev/null", c.O_RDWR | c.O_CLOEXEC);
        if (null_fd < 0) fail_spawn(status_pipe[1]);
        inline for (0..3) |standard| {
            if (c.dup2(null_fd, standard) < 0) fail_spawn(status_pipe[1]);
        }
        if (null_fd > 2) _ = c.close(null_fd);
        if (c.close_range(3, std.math.maxInt(c_uint), c.CLOSE_RANGE_CLOEXEC) != 0 or !inheritable(pair[1]) or !inheritable(inherited_lock)) fail_spawn(status_pipe[1]);
        _ = c.execv(executable.ptr, @ptrCast(&argv));
        fail_spawn(status_pipe[1]);
    }
    _ = c.close(status_pipe[1]);
    status_pipe[1] = -1;
    var wait_status: c_int = undefined;
    while (true) {
        const waited = c.waitpid(pid, &wait_status, c.WNOHANG);
        if (waited == pid) break;
        if (waited < 0 and errno_value() != c.EINTR) return error.WaitFailed;
        if (now_ms() >= deadline) return error.StartupTimeout;
        _ = c.poll(null, 0, 10);
    }
    if (!c.WIFEXITED(wait_status) or c.WEXITSTATUS(wait_status) != 0) return error.ServerForkFailed;
    var poll_fd = c.struct_pollfd{ .fd = status_pipe[0], .events = c.POLLIN | c.POLLHUP, .revents = 0 };
    while (true) {
        const remaining = deadline - now_ms();
        if (remaining <= 0) return error.StartupTimeout;
        const result = c.poll(&poll_fd, 1, @intCast(remaining));
        if (result < 0 and errno_value() == c.EINTR) continue;
        if (result <= 0) return error.StartupFailed;
        var data: [1]u8 = undefined;
        const count = c.read(status_pipe[0], &data, 1);
        if (count == 0) break;
        return error.StartupFailed;
    }
    try nonblocking(pair[0]);
    return pair[0];
}

pub fn connect_or_start(allocator: std.mem.Allocator, path: [:0]const u8, can_start: bool) !c_int {
    const deadline = now_ms() + wire.timeout_ms;
    return connect_once(path, deadline) catch |initial_error| {
        if (!can_start or (initial_error != error.SocketMissing and initial_error != error.ConnectionRefused)) return initial_error;
        const lock_fd = try startup_lock(allocator, path, deadline);
        defer _ = c.close(lock_fd);
        return connect_once(path, deadline) catch |retry_error| {
            if (retry_error != error.SocketMissing and retry_error != error.ConnectionRefused) return retry_error;
            return spawn(path, lock_fd, deadline);
        };
    };
}

pub fn listen(path: [:0]const u8, lock_fd: c_int) !c_int {
    defer _ = c.close(lock_fd);
    try check_parent(path);
    var lock_text: [sockaddr_limit + 6]u8 = undefined;
    const lock_path = try std.fmt.bufPrintZ(&lock_text, "{s}.lock", .{path});
    var lock_stat: c.struct_stat = undefined;
    var file_stat: c.struct_stat = undefined;
    if (lock_fd < 0 or c.fstat(lock_fd, &lock_stat) != 0 or c.lstat(lock_path.ptr, &file_stat) != 0) return error.UnsafeLock;
    if (lock_stat.st_mode & c.S_IFMT != c.S_IFREG or lock_stat.st_uid != c.geteuid() or lock_stat.st_mode & 0o077 != 0 or lock_stat.st_nlink != 1 or lock_stat.st_ino != file_stat.st_ino or lock_stat.st_dev != file_stat.st_dev or file_stat.st_mode & c.S_IFMT != c.S_IFREG) return error.UnsafeLock;
    if (c.flock(lock_fd, c.LOCK_EX | c.LOCK_NB) != 0) return error.LockFailed;
    const stale = try socket_stat(path);
    if (stale != null and c.unlink(path.ptr) != 0) return error.SocketUnlinkFailed;
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM | c.SOCK_CLOEXEC | c.SOCK_NONBLOCK, 0);
    if (fd < 0) return error.SocketCreateFailed;
    errdefer _ = c.close(fd);
    var addr = try address(path);
    const previous_umask = c.umask(0o177);
    const result = c.bind(fd, .{ .__sockaddr_un__ = &addr }, @sizeOf(c.struct_sockaddr_un));
    _ = c.umask(previous_umask);
    if (result != 0) return error.BindFailed;
    errdefer {
        if ((socket_stat(path) catch null) != null) _ = c.unlink(path.ptr);
    }
    if (c.chmod(path.ptr, 0o600) != 0 or c.listen(fd, 16) != 0) return error.ListenFailed;
    const stat = (try socket_stat(path)) orelse return error.SocketMissing;
    bound_inode = stat.st_ino;
    bound_device = stat.st_dev;
    return fd;
}

pub fn cleanup(path: [:0]const u8, listener: c_int) void {
    _ = c.close(listener);
    const stat = socket_stat(path) catch return;
    if (stat) |socket| {
        if (socket.st_ino == bound_inode and socket.st_dev == bound_device and bound_inode != 0) _ = c.unlink(path.ptr);
    }
    bound_inode = 0;
}
