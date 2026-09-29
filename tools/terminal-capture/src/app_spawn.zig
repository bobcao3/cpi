const std = @import("std");
const c = @import("native.zig").c;
const wire = @import("wire.zig");
const options = @import("options.zig");

pub const Spawn = struct { pid: c_int, master: c_int };

pub fn start(arena: std.mem.Allocator, request: wire.Request, cell_width: u32, cell_height: u32) !Spawn {
    try options.geometry(request.cols, request.rows);
    if (request.argv.len == 0 or request.argv.len > 256) return error.InvalidArguments;
    const cwd = request.cwd orelse return error.InvalidCwd;
    if (cwd.len == 0 or cwd.len > 4096 or cwd[0] != '/' or std.mem.indexOfScalar(u8, cwd, 0) != null) return error.InvalidCwd;
    if (request.env.len > 1024) return error.InvalidEnvironment;
    var total: usize = 0;
    for (request.argv) |arg| {
        total += arg.len;
        if (arg.len > 4096 or total > 256 * 1024 or std.mem.indexOfScalar(u8, arg, 0) != null) return error.InvalidArguments;
    }
    if (request.argv[0].len == 0) return error.InvalidArguments;
    total = 0;
    for (request.env) |entry| {
        total += entry.len;
        const equal = std.mem.indexOfScalar(u8, entry, '=') orelse return error.InvalidEnvironment;
        if (equal == 0 or entry.len > 16384 or total > 256 * 1024 or std.mem.indexOfScalar(u8, entry, 0) != null) return error.InvalidEnvironment;
    }

    const argv = try arena.allocSentinel(?[*:0]const u8, request.argv.len, null);
    for (request.argv, 0..) |arg, index| argv[index] = (try arena.dupeZ(u8, arg)).ptr;
    const env = try arena.allocSentinel(?[*:0]const u8, request.env.len + 3, null);
    var count: usize = 0;
    var path: []const u8 = "/bin:/usr/bin";
    for (request.env) |entry| {
        const equal = std.mem.indexOfScalar(u8, entry, '=').?;
        const name = entry[0..equal];
        if (std.mem.eql(u8, name, "PATH")) path = entry[equal + 1 ..];
        if (std.mem.eql(u8, name, "TERM") or std.mem.eql(u8, name, "COLORTERM") or std.mem.eql(u8, name, "TERM_PROGRAM")) continue;
        env[count] = (try arena.dupeZ(u8, entry)).ptr;
        count += 1;
    }
    inline for (.{ "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=terminal-capture" }) |entry| {
        env[count] = entry;
        count += 1;
    }
    env[count] = null;
    const executable = try resolve(arena, cwd, request.argv[0], path);
    const child_cwd = try arena.dupeZ(u8, cwd);
    var master: c_int = -1;
    var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
    size.ws_col = request.cols;
    size.ws_row = request.rows;
    size.ws_xpixel = @intCast(@as(u32, request.cols) * cell_width);
    size.ws_ypixel = @intCast(@as(u32, request.rows) * cell_height);
    const pid = c.forkpty(&master, null, null, &size);
    if (pid < 0) return error.ForkPtyFailed;
    if (pid == 0) {
        if (c.close_range(3, std.math.maxInt(c_uint), 0) != 0) c._exit(126);
        if (c.chdir(child_cwd.ptr) != 0) c._exit(126);
        _ = c.execve(executable.ptr, @ptrCast(argv.ptr), @ptrCast(env.ptr));
        c._exit(127);
    }
    errdefer stop(pid, master);
    const flags = c.fcntl(master, c.F_GETFL);
    if (flags < 0 or c.fcntl(master, c.F_SETFL, flags | c.O_NONBLOCK) < 0 or c.fcntl(master, c.F_SETFD, c.FD_CLOEXEC) < 0) return error.PtyConfigurationFailed;
    return .{ .pid = pid, .master = master };
}

fn resolve(arena: std.mem.Allocator, cwd: []const u8, command: []const u8, path: []const u8) ![:0]u8 {
    if (std.mem.indexOfScalar(u8, command, '/') != null) {
        const name = if (command[0] == '/') command else try std.fs.path.join(arena, &.{ cwd, command });
        if (name.len > 4096) return error.InvalidArguments;
        return arena.dupeZ(u8, name);
    }
    var parts = std.mem.splitScalar(u8, path, ':');
    var attempts: usize = 0;
    while (parts.next()) |part| {
        attempts += 1;
        if (attempts > 1024) return error.InvalidEnvironment;
        const directory = if (part.len == 0) cwd else if (part[0] == '/') part else try std.fs.path.join(arena, &.{ cwd, part });
        const candidate = try std.fs.path.join(arena, &.{ directory, command });
        if (candidate.len > 4096) continue;
        const z = try arena.dupeZ(u8, candidate);
        var stat: c.struct_stat = undefined;
        if (c.stat(z.ptr, &stat) == 0 and (stat.st_mode & c.S_IFMT) == c.S_IFREG and c.access(z.ptr, c.X_OK) == 0) return z;
    }
    return error.ExecutableNotFound;
}

pub fn stop(pid: c_int, master: c_int) void {
    if (pid <= 0) return;
    if (master >= 0) {
        const foreground = c.tcgetpgrp(master);
        if (foreground > 0 and foreground != c.getpgrp()) {
            _ = c.kill(-foreground, c.SIGHUP);
            _ = c.kill(-foreground, c.SIGKILL);
        }
    }
    _ = c.kill(-pid, c.SIGHUP);
    _ = c.kill(-pid, c.SIGKILL);
    _ = c.kill(pid, c.SIGKILL);
    if (master >= 0) _ = c.close(master);
    var status: c_int = undefined;
    for (0..100) |_| {
        const result = c.waitpid(pid, &status, c.WNOHANG);
        if (result == pid or (result < 0 and std.c.errno(result) == .CHILD)) return;
        if (result < 0 and std.c.errno(result) != .INTR) return;
        _ = c.usleep(10_000);
    }
}
