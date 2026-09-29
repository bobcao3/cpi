const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;

pub fn uid() u32 {
    return if (builtin.os.tag == .windows) 0 else posix.system.geteuid();
}

pub fn owner(path: [:0]const u8) !u32 {
    if (builtin.os.tag == .linux) return linux_owner(posix.AT.FDCWD, path, posix.AT.SYMLINK_NOFOLLOW);
    var stat: posix.Stat = undefined;
    if (posix.errno(posix.system.fstatat(posix.AT.FDCWD, path, &stat, posix.AT.SYMLINK_NOFOLLOW)) != .SUCCESS) return error.OwnerStatFailed;
    return stat.uid;
}

pub fn file_owner(file: std.Io.File) !u32 {
    if (builtin.os.tag == .linux) return linux_owner(file.handle, "", std.os.linux.AT.EMPTY_PATH);
    var stat: posix.Stat = undefined;
    if (posix.errno(posix.system.fstat(file.handle, &stat)) != .SUCCESS) return error.OwnerStatFailed;
    return stat.uid;
}

fn linux_owner(fd: posix.fd_t, path: [:0]const u8, flags: u32) !u32 {
    var stat: std.os.linux.Statx = std.mem.zeroes(std.os.linux.Statx);
    if (posix.errno(posix.system.statx(fd, path, flags, .{ .UID = true }, &stat)) != .SUCCESS or !stat.mask.UID) return error.OwnerStatFailed;
    return stat.uid;
}

pub fn detach() !void {
    if (builtin.os.tag == .windows) return;
    if (posix.system.setsid() < 0) return error.DetachFailed;
}

pub fn peer(stream: std.Io.net.Stream) !void {
    if (builtin.os.tag == .linux) {
        var credential: extern struct { pid: posix.pid_t, uid: posix.uid_t, gid: posix.gid_t } = undefined;
        var length: posix.socklen_t = @sizeOf(@TypeOf(credential));
        if (posix.errno(posix.system.getsockopt(stream.socket.handle, posix.SOL.SOCKET, posix.SO.PEERCRED, @ptrCast(&credential), &length)) != .SUCCESS) return error.PeerCredentialsFailed;
        if (length != @sizeOf(@TypeOf(credential))) return error.PeerCredentialsFailed;
        if (credential.uid != uid()) return error.UnsafePeer;
    }
}

var interrupted = std.atomic.Value(bool).init(false);

fn on_signal(_: posix.SIG) callconv(.c) void {
    interrupted.store(true, .release);
}

pub const Signals = struct {
    term: posix.Sigaction = undefined,
    interrupt: posix.Sigaction = undefined,

    pub fn init() Signals {
        var self: Signals = .{};
        if (builtin.os.tag != .windows) {
            interrupted.store(false, .release);
            const action: posix.Sigaction = .{ .handler = .{ .handler = on_signal }, .mask = posix.sigemptyset(), .flags = 0 };
            posix.sigaction(.TERM, &action, &self.term);
            posix.sigaction(.INT, &action, &self.interrupt);
        }
        return self;
    }

    pub fn deinit(self: *Signals) void {
        if (builtin.os.tag == .windows) return;
        posix.sigaction(.TERM, &self.term, null);
        posix.sigaction(.INT, &self.interrupt, null);
    }

    pub fn requested() bool {
        return interrupted.load(.acquire);
    }
};
