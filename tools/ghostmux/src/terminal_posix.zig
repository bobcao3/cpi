const std = @import("std");
const posix = std.posix;
const system = posix.system;
const wire = @import("wire.zig");
const resize_request: c_int = @bitCast(@as(u32, if (@import("builtin").os.tag == .macos) 0x80000000 | (@sizeOf(posix.winsize) << 16) | ('t' << 8) | 103 else system.T.IOCSWINSZ));

extern "c" fn forkpty(master: *c_int, name: ?[*]u8, termios: ?*const posix.termios, size: *const posix.winsize) c_int;
extern "c" fn tcgetpgrp(fd: c_int) c_int;
extern "c" fn getpgrp() c_int;

pub const Spawn = struct { child: std.process.Child, input: ?std.Io.File, output: std.Io.File, pid: i32, terminal: Terminal };

pub const start_pipes = @import("process_pipes_posix.zig").start;

pub const Terminal = struct {
    master: ?posix.fd_t,
    output: ?std.Io.File = null,

    pub fn resize(self: *Terminal, cols: u16, rows: u16, cell_width: u32, cell_height: u32) !void {
        if (self.output != null) return error.NotPty;
        var size = try dimensions(cols, rows, cell_width, cell_height);
        const master = self.master orelse return error.TerminalClosed;
        if (system.ioctl(master, resize_request, @intFromPtr(&size)) != 0) return error.PtyResizeFailed;
    }

    pub fn finish_output(_: *Terminal, _: std.Io) void {}

    pub fn signal(self: *Terminal, pid: i32, name: []const u8) !void {
        const requested = try @import("process_signal.zig").parse(name);
        const server_group = getpgrp();
        if (pid <= 0 or pid == server_group) return error.UnsafeProcessGroup;
        const foreground = if (self.master) |master| tcgetpgrp(master) else pid;
        var delivered = false;
        var failure: ?posix.KillError = null;
        for ([_]i32{ pid, foreground }, 0..) |group, index| {
            if (group <= 0 or group == server_group) continue;
            if (index == 1 and group == pid) continue;
            posix.kill(-group, requested) catch |err| {
                if (err == error.ProcessNotFound and index == 0) {
                    posix.kill(pid, requested) catch |leader_error| {
                        if (leader_error != error.ProcessNotFound) failure = failure orelse leader_error;
                        continue;
                    };
                    delivered = true;
                } else if (err != error.ProcessNotFound) failure = failure orelse err;
                continue;
            };
            delivered = true;
        }
        if (failure) |err| return err;
        if (!delivered) return error.ProcessNotFound;
    }

    pub fn stop(self: *Terminal, pid: i32) void {
        if (self.master) |master| {
            const foreground = tcgetpgrp(master);
            if (foreground > 0 and foreground != getpgrp()) {
                posix.kill(-foreground, .HUP) catch {};
                posix.kill(-foreground, .KILL) catch {};
            }
        }
        posix.kill(-pid, .HUP) catch {};
        posix.kill(-pid, .KILL) catch {};
    }

    pub fn deinit(self: *Terminal, io: std.Io) void {
        if (self.output) |output| {
            self.output = null;
            output.close(io);
        }
        if (self.master) |master| {
            self.master = null;
            const file: std.Io.File = .{ .handle = master, .flags = .{ .nonblocking = false } };
            file.close(io);
        }
    }
};

pub fn start(allocator: std.mem.Allocator, io: std.Io, request: wire.Request, cell_width: u32, cell_height: u32) !Spawn {
    const cwd = request.cwd.?;
    const argv = try allocator.allocSentinel(?[*:0]const u8, request.argv.len, null);
    for (request.argv, 0..) |arg, index| argv[index] = (try allocator.dupeZ(u8, arg)).ptr;
    const env = try allocator.allocSentinel(?[*:0]const u8, request.env.len + 3, null);
    var count: usize = 0;
    var path: []const u8 = "/bin:/usr/bin";
    for (request.env) |entry| {
        const equal = std.mem.indexOfScalar(u8, entry, '=').?;
        const name = entry[0..equal];
        if (std.mem.eql(u8, name, "PATH")) path = entry[equal + 1 ..];
        if (std.mem.eql(u8, name, "TERM") or std.mem.eql(u8, name, "COLORTERM") or std.mem.eql(u8, name, "TERM_PROGRAM")) continue;
        env[count] = (try allocator.dupeZ(u8, entry)).ptr;
        count += 1;
    }
    inline for (.{ "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=ghostmux" }) |entry| {
        env[count] = entry;
        count += 1;
    }
    env[count] = null;
    const executable = try resolve(allocator, io, cwd, request.argv[0], path);
    const child_cwd = try allocator.dupeZ(u8, cwd);
    const limit = try posix.getrlimit(.NOFILE);
    const maximum = if (limit.max == posix.RLIM.INFINITY) limit.cur else limit.max;
    if (maximum == posix.RLIM.INFINITY or maximum > 16777216) return error.DescriptorLimitTooLarge;
    var master: posix.fd_t = undefined;
    var size = try dimensions(request.cols, request.rows, cell_width, cell_height);
    const pid = forkpty(&master, null, null, &size);
    if (pid < 0) return error.ForkPtyFailed;
    if (pid == 0) {
        close_inherited(@intCast(maximum));
        if (system.chdir(child_cwd.ptr) != 0) system._exit(126);
        _ = system.execve(executable.ptr, argv.ptr, env.ptr);
        system._exit(127);
    }
    var child: std.process.Child = .{ .id = pid, .thread_handle = {}, .stdin = null, .stdout = null, .stderr = null, .request_resource_usage_statistics = false };
    errdefer child.kill(io);
    var terminal: Terminal = .{ .master = master };
    errdefer terminal.deinit(io);
    if (system.fcntl(master, posix.F.SETFD, @as(c_int, posix.FD_CLOEXEC)) < 0) return error.PtyConfigurationFailed;
    const file: std.Io.File = .{ .handle = master, .flags = .{ .nonblocking = false } };
    return .{ .child = child, .input = file, .output = file, .pid = pid, .terminal = terminal };
}

pub fn close_inherited(maximum: u32) void {
    const first = posix.STDERR_FILENO + 1;
    if (@import("builtin").os.tag == .linux) {
        if (std.os.linux.close_range(first, std.math.maxInt(posix.fd_t), .{ .UNSHARE = false, .CLOEXEC = false }) == 0) return;
    }
    var descriptor: c_int = first;
    while (descriptor < maximum) : (descriptor += 1) _ = system.close(descriptor);
}

fn dimensions(cols: u16, rows: u16, cell_width: u32, cell_height: u32) !posix.winsize {
    const width = std.math.mul(u32, cols, cell_width) catch return error.InvalidGeometry;
    const height = std.math.mul(u32, rows, cell_height) catch return error.InvalidGeometry;
    return .{ .col = cols, .row = rows, .xpixel = std.math.cast(u16, width) orelse return error.InvalidGeometry, .ypixel = std.math.cast(u16, height) orelse return error.InvalidGeometry };
}

pub fn resolve(allocator: std.mem.Allocator, io: std.Io, cwd: []const u8, command: []const u8, path: []const u8) ![:0]u8 {
    if (std.mem.indexOfScalar(u8, command, '/') != null) {
        const name = if (command[0] == '/') command else try std.fs.path.join(allocator, &.{ cwd, command });
        if (name.len > 4096) return error.InvalidArguments;
        return allocator.dupeZ(u8, name);
    }
    var parts = std.mem.splitScalar(u8, path, ':');
    var attempts: usize = 0;
    while (parts.next()) |part| {
        attempts += 1;
        if (attempts > 1024) return error.InvalidEnvironment;
        const directory = if (part.len == 0) cwd else if (part[0] == '/') part else try std.fs.path.join(allocator, &.{ cwd, part });
        const candidate = try std.fs.path.join(allocator, &.{ directory, command });
        if (candidate.len > 4096) continue;
        const stat = std.Io.Dir.cwd().statFile(io, candidate, .{}) catch continue;
        if (stat.kind != .file) continue;
        std.Io.Dir.cwd().access(io, candidate, .{ .execute = true }) catch continue;
        return allocator.dupeZ(u8, candidate);
    }
    return error.ExecutableNotFound;
}
