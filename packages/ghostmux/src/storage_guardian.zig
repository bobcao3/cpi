const std = @import("std");
const linux = std.os.linux;
const posix = std.posix;
const store = @import("guardian_store.zig");
const tree = @import("guardian_tree.zig");
const Dir = std.Io.Dir;
const now = @import("transport.zig").now_ms;

const Input = struct {
    bytes: [16384]u8 = undefined,
    length: usize = 0,
    enabled: bool = true,

    fn next(self: *Input) !?[]const u8 {
        while (self.enabled) {
            var byte: [1]u8 = undefined;
            const count = linux.read(0, &byte, 1);
            switch (linux.errno(count)) {
                .AGAIN => return null,
                .INTR => continue,
                .SUCCESS => {},
                else => return error.ControlReadFailed,
            }
            if (count == 0) {
                self.enabled = false;
                return null;
            }
            if (byte[0] == '\n') {
                const line = self.bytes[0..self.length];
                self.length = 0;
                return line;
            }
            if (self.length == self.bytes.len - 1) return error.ControlLineTooLong;
            self.bytes[self.length] = byte[0];
            self.length += 1;
        }
        return null;
    }
};

fn nonblocking(fd: i32) !void {
    const flags = linux.fcntl(fd, linux.F.GETFL, 0);
    if (linux.errno(flags) != .SUCCESS) return error.PipeFlagsFailed;
    const nonblock: linux.O = .{ .NONBLOCK = true };
    if (linux.errno(linux.fcntl(fd, linux.F.SETFL, flags | @as(u32, @bitCast(nonblock)))) != .SUCCESS) return error.PipeFlagsFailed;
}

fn poll(fds: []linux.pollfd, timeout: i32) !void {
    const result = linux.poll(fds.ptr, @intCast(fds.len), timeout);
    switch (linux.errno(result)) {
        .SUCCESS, .INTR => {},
        else => return error.WatchFailed,
    }
    for (fds) |fd| if (fd.revents & linux.POLL.NVAL != 0) return error.InvalidWatch;
}

fn exited(pidfd: i32) !bool {
    var fds = [_]linux.pollfd{.{ .fd = pidfd, .events = linux.POLL.IN, .revents = 0 }};
    try poll(&fds, 0);
    return fds[0].revents & (linux.POLL.IN | linux.POLL.HUP) != 0;
}

fn respond(io: std.Io, state: []const u8, path: []const u8, record: []const u8, failure: ?[]const u8) void {
    const Response = struct { version: u32 = 1, state: []const u8, path: []const u8, record: []const u8, @"error": ?[]const u8 };
    var bytes: [32768]u8 = undefined;
    var writer = std.Io.Writer.fixed(&bytes);
    std.json.Stringify.value(Response{ .state = state, .path = path, .record = record, .@"error" = failure }, .{ .emit_null_optional_fields = false }, &writer) catch return;
    writer.writeByte('\n') catch return;
    var offset: usize = 0;
    const deadline = now(io) + 1000;
    while (offset < writer.end and now(io) < deadline) {
        var fds = [_]linux.pollfd{.{ .fd = 1, .events = linux.POLL.OUT, .revents = 0 }};
        poll(&fds, 50) catch return;
        if (fds[0].revents & (linux.POLL.ERR | linux.POLL.HUP) != 0) return;
        if (fds[0].revents & linux.POLL.OUT == 0) continue;
        const count = linux.write(1, bytes[offset..].ptr, writer.end - offset);
        switch (linux.errno(count)) {
            .AGAIN, .INTR => continue,
            .SUCCESS => offset += count,
            else => return,
        }
    }
}

pub fn run(allocator: std.mem.Allocator, io: std.Io) !void {
    if (@import("builtin").os.tag != .linux) return error.StorageGuardianUnsupported;
    const parent = linux.getppid();
    if (parent <= 1) return error.MissingTrustedParent;
    const opened = linux.pidfd_open(parent, 0);
    if (linux.errno(opened) != .SUCCESS) return error.PidfdUnavailable;
    const pidfd: i32 = @intCast(opened);
    defer _ = linux.close(pidfd);
    if (linux.getppid() != parent) return error.ParentChanged;
    if (linux.errno(linux.setsid()) != .SUCCESS and linux.getpgid(0) != @as(usize, @intCast(linux.getpid()))) return error.DetachFailed;
    const ignore: posix.Sigaction = .{ .handler = .{ .handler = posix.SIG.IGN }, .mask = posix.sigemptyset(), .flags = 0 };
    posix.sigaction(.PIPE, &ignore, null);
    try nonblocking(0);
    try nonblocking(1);
    var input: Input = .{};
    const deadline = now(io) + 10000;
    const initial = while (now(io) < deadline) {
        if (try exited(pidfd)) return error.HostAlreadyExited;
        if (try input.next()) |line| break line;
        if (!input.enabled) return error.MissingRegistration;
        var fds = [_]linux.pollfd{ .{ .fd = pidfd, .events = linux.POLL.IN, .revents = 0 }, .{ .fd = 0, .events = linux.POLL.IN, .revents = 0 } };
        try poll(&fds, 100);
    } else return error.RegistrationTimeout;
    const parsed = try std.json.parseFromSlice(store.Request, allocator, initial, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const request = parsed.value;
    if (request.version != 1 or request.host_pid != parent or !store.valid_id(request.id) or request.session_id.len == 0 or request.session_id.len > 1024) return error.InvalidRegistration;
    if (!std.fs.path.isAbsolute(request.session_dir) or request.session_dir.len > 4096 or std.mem.indexOfScalar(u8, request.session_dir, 0) != null) return error.InvalidSessionDirectory;
    const canonical = try Dir.cwd().realPathFileAlloc(io, request.session_dir, allocator);
    defer allocator.free(canonical);
    if (!std.mem.eql(u8, canonical, request.session_dir)) return error.NonCanonicalSessionDirectory;
    var root = try tree.private_dir(allocator, io, request.root);
    defer root.close(io);
    var journal = try tree.private_dir(allocator, io, request.journal);
    defer journal.close(io);
    if ((try tree.identity(root)).eql(try tree.identity(journal))) return error.OverlappingDirectories;
    try store.reconcile(allocator, io, root, journal, request);
    const held = try store.lock(allocator, io, journal, request.id);
    defer held.close(io);
    const name = try store.basename(allocator, request.id, request.retain);
    defer allocator.free(name);
    const path = try std.fs.path.join(allocator, &.{ request.root, name });
    defer allocator.free(path);
    const record_name = try store.filename(allocator, request.id);
    defer allocator.free(record_name);
    const record_path = try std.fs.path.join(allocator, &.{ request.journal, record_name });
    defer allocator.free(record_path);
    if (path.len >= 4096 or record_path.len >= 4096) return error.GuardianPathTooLong;
    var record: store.Record = .{ .owner_uid = @import("runtime_security.zig").uid(), .guardian_pid = linux.getpid(), .host_pid = parent, .session_id = request.session_id, .session_dir = request.session_dir, .root = request.root, .journal = request.journal, .id = request.id, .path = path, .root_identity = try tree.identity(root), .retain = request.retain };
    if (try exited(pidfd)) return error.HostAlreadyExited;
    try store.save(allocator, io, journal, record, true);
    try root.createDir(io, name, .fromMode(0o700));
    var scope = try root.openDir(io, name, .{ .follow_symlinks = false });
    defer scope.close(io);
    record.identity = try tree.identity(scope);
    try tree.sync(root, io);
    try store.save(allocator, io, journal, record, false);
    if (!try exited(pidfd)) respond(io, "ready", path, record_path, null);
    try watch(allocator, io, pidfd, root, journal, &record, record_path, &input);
}

fn watch(allocator: std.mem.Allocator, io: std.Io, pidfd: i32, root: Dir, journal: Dir, record: *store.Record, record_path: []const u8, input: *Input) !void {
    var death_deadline: ?i64 = null;
    var retry_at: i64 = 0;
    while (true) {
        if (death_deadline == null and try exited(pidfd)) {
            record.host_closed = true;
            record.closure_evidence = .pidfd_exit;
            death_deadline = now(io) + 60000;
        }
        if (death_deadline) |deadline| {
            if (now(io) >= retry_at) {
                const failure: ?[]const u8 = if (store.finish(allocator, io, root, journal, record)) |_| null else |err| @errorName(err);
                respond(io, @tagName(record.state), record.path, record_path, failure);
                if (failure == null) return;
                retry_at = now(io) + 1000;
            }
            if (now(io) >= deadline) return;
        } else if (input.enabled) {
            const line = input.next() catch {
                input.enabled = false;
                continue;
            };
            if (line) |bytes| {
                const Command = struct { command: enum { close, query } };
                const parsed = std.json.parseFromSlice(Command, allocator, bytes, .{}) catch {
                    respond(io, "pending", record.path, record_path, "InvalidCommand");
                    continue;
                };
                defer parsed.deinit();
                var failure: ?[]const u8 = record.error_name;
                if (parsed.value.command == .close) {
                    record.closure_evidence = .controller_close;
                    failure = if (store.finish(allocator, io, root, journal, record)) |_| null else |err| @errorName(err);
                }
                respond(io, @tagName(record.state), record.path, record_path, failure);
                if (failure == null and record.state != .pending) return;
                continue;
            }
        }
        var fds = [_]linux.pollfd{ .{ .fd = if (death_deadline == null) pidfd else -1, .events = linux.POLL.IN, .revents = 0 }, .{ .fd = if (input.enabled and death_deadline == null) 0 else -1, .events = linux.POLL.IN, .revents = 0 } };
        try poll(&fds, 1000);
    }
}
