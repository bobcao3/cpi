const std = @import("std");
const posix = std.posix;
const terminal = @import("terminal_posix.zig");
const wire = @import("wire.zig");

pub fn start(allocator: std.mem.Allocator, io: std.Io, request: wire.Request) !terminal.Spawn {
    var path: []const u8 = "/bin:/usr/bin";
    for (request.env) |entry| {
        const equal = std.mem.indexOfScalar(u8, entry, '=').?;
        const name = entry[0..equal];
        if (std.mem.eql(u8, name, "PATH")) path = entry[equal + 1 ..];
    }
    const executable = try terminal.resolve(allocator, io, request.cwd.?, request.argv[0], path);
    const descriptors = try std.Io.Threaded.pipe2(.{ .CLOEXEC = true });
    const output: std.Io.File = .{ .handle = descriptors[0], .flags = .{ .nonblocking = false } };
    errdefer output.close(io);
    const writer: std.Io.File = .{ .handle = descriptors[1], .flags = .{ .nonblocking = false } };
    defer writer.close(io);
    const child = try spawn(allocator, io, request, executable, writer);
    std.debug.assert(child.stdin == null and child.stdout == null and child.stderr == null);
    return .{ .child = child, .input = null, .output = output, .pid = child.id.?, .terminal = .{ .master = null, .output = output } };
}

fn spawn(allocator: std.mem.Allocator, io: std.Io, request: wire.Request, executable: [:0]const u8, writer: std.Io.File) !std.process.Child {
    const argv = try allocator.allocSentinel(?[*:0]const u8, request.argv.len, null);
    for (request.argv, 0..) |arg, index| argv[index] = (try allocator.dupeZ(u8, arg)).ptr;
    const env = try allocator.allocSentinel(?[*:0]const u8, request.env.len, null);
    for (request.env, 0..) |entry, index| env[index] = (try allocator.dupeZ(u8, entry)).ptr;
    const cwd = try allocator.dupeZ(u8, request.cwd.?);
    const null_input = try std.Io.Dir.openFileAbsolute(io, "/dev/null", .{});
    defer null_input.close(io);
    const limit = try posix.getrlimit(.NOFILE);
    const maximum = if (limit.max == posix.RLIM.INFINITY) limit.cur else limit.max;
    if (maximum == posix.RLIM.INFINITY or maximum > 16777216) return error.DescriptorLimitTooLarge;
    const pid = posix.system.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        if (posix.system.setpgid(0, 0) != 0 or posix.system.chdir(cwd.ptr) != 0) posix.system._exit(126);
        if (posix.system.dup2(null_input.handle, posix.STDIN_FILENO) < 0 or
            posix.system.dup2(writer.handle, posix.STDOUT_FILENO) < 0 or
            posix.system.dup2(writer.handle, posix.STDERR_FILENO) < 0) posix.system._exit(126);
        terminal.close_inherited(@intCast(maximum));
        _ = posix.system.execve(executable.ptr, argv.ptr, env.ptr);
        posix.system._exit(127);
    }
    return .{ .id = pid, .thread_handle = {}, .stdin = null, .stdout = null, .stderr = null, .request_resource_usage_statistics = false };
}
