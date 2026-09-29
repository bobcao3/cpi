const std = @import("std");
const c = @import("native.zig").c;
const wire = @import("wire.zig");
const transport = @import("transport.zig");
const Channel = @import("channel.zig");
const App = @import("app.zig");
const protocol = @import("protocol.zig");
const Self = @This();

allocator: std.mem.Allocator,
io: std.Io,
apps: [wire.max_sessions]?*App = @splat(null),
clients: [wire.max_clients]?*Channel = @splat(null),
stopping: bool = false,

var interrupted = std.atomic.Value(bool).init(false);
fn on_signal(_: c_int) callconv(.c) void {
    interrupted.store(true, .monotonic);
}

pub fn run(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8, initial_fd: c_int, lock_fd: c_int) !void {
    const listener = try transport.listen(path, lock_fd);
    defer transport.cleanup(path, listener);
    _ = c.signal(c.SIGTERM, &on_signal);
    _ = c.signal(c.SIGINT, &on_signal);
    var self: Self = .{ .allocator = allocator, .io = io };
    defer {
        for (self.clients) |client| if (client) |value| value.deinit();
        for (self.apps) |app| if (app) |value| value.deinit();
    }
    self.clients[0] = Channel.init(allocator, initial_fd) catch |err| {
        _ = c.close(initial_fd);
        return err;
    };
    while (true) {
        if (interrupted.load(.monotonic)) return;
        var descriptors: [1 + wire.max_clients + wire.max_sessions]c.struct_pollfd = undefined;
        descriptors[0] = .{ .fd = if (self.stopping) -1 else listener, .events = c.POLLIN, .revents = 0 };
        for (self.clients, 0..) |client, i| descriptors[i + 1] = .{
            .fd = if (client) |value| value.fd else -1,
            .events = if (client) |value| value.events() else 0,
            .revents = 0,
        };
        for (self.apps, 0..) |app, i| descriptors[i + 1 + wire.max_clients] = .{
            .fd = if (app) |value| value.master else -1,
            .events = if (app) |value| value.events() else 0,
            .revents = 0,
        };
        const count = c.poll(&descriptors, descriptors.len, 50);
        if (count < 0) {
            if (std.c.errno(count) == .INTR) continue;
            return error.PollFailed;
        }
        for (&self.apps, 0..) |*app, i| if (app.*) |value| {
            value.step(descriptors[i + 1 + wire.max_clients].revents) catch {
                value.deinit();
                app.* = null;
            };
        };
        if (descriptors[0].revents & c.POLLIN != 0) try self.accept_client(listener);
        for (&self.clients, 0..) |*client, i| if (client.*) |value| {
            const revents = descriptors[i + 1].revents;
            const close = self.advance(value, revents) catch true;
            if (close) {
                value.deinit();
                client.* = null;
            }
        };
        const has_clients = for (self.clients) |client| {
            if (client != null) break true;
        } else false;
        const has_apps = for (self.apps) |app| {
            if (app != null) break true;
        } else false;
        if (!has_clients and (self.stopping or !has_apps)) return;
    }
}

fn accept_client(self: *Self, listener: c_int) !void {
    for (0..wire.max_clients) |_| {
        const fd = c.accept4(listener, .{ .__sockaddr__ = null }, null, c.SOCK_CLOEXEC | c.SOCK_NONBLOCK);
        if (fd < 0) return switch (std.c.errno(fd)) {
            .AGAIN, .INTR => {},
            else => error.AcceptFailed,
        };
        var credential: c.struct_ucred = undefined;
        var length: c.socklen_t = @sizeOf(c.struct_ucred);
        if (c.getsockopt(fd, c.SOL_SOCKET, c.SO_PEERCRED, &credential, &length) != 0 or credential.uid != c.geteuid()) {
            _ = c.close(fd);
            continue;
        }
        const slot = for (&self.clients) |*client| {
            if (client.* == null) break client;
        } else {
            _ = c.close(fd);
            continue;
        };
        slot.* = Channel.init(self.allocator, fd) catch {
            _ = c.close(fd);
            continue;
        };
    }
}

fn advance(self: *Self, client: *Channel, events: c_short) !bool {
    if (transport.now_ms() >= client.deadline) return true;
    if (self.stopping and client.output == null) return true;
    if (events & c.POLLNVAL != 0) return true;
    if (client.output != null) {
        if (events & (c.POLLOUT | c.POLLHUP | c.POLLERR) != 0) return client.flush();
        return false;
    }
    if (events & (c.POLLIN | c.POLLHUP | c.POLLERR) == 0) return false;
    const body = try client.receive() orelse return false;
    var arena = std.heap.ArenaAllocator.init(self.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const response = self.dispatch(allocator, body) catch |err| wire.Response{
        .ok = false,
        .error_name = @errorName(err),
        .server_pid = c.getpid(),
    };
    client.respond(response) catch |err| try client.respond(.{
        .ok = false,
        .error_name = @errorName(err),
        .server_pid = c.getpid(),
    });
    return false;
}

fn dispatch(self: *Self, allocator: std.mem.Allocator, body: []const u8) !wire.Response {
    const parsed = try std.json.parseFromSlice(wire.Request, allocator, body, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const request = parsed.value;
    if (request.version != wire.protocol_version) return error.ProtocolVersionMismatch;
    if (self.stopping) return error.ServerShuttingDown;
    var response: wire.Response = .{ .server_pid = c.getpid() };
    switch (request.op) {
        .new_session => {
            const uid = request.uid orelse return error.MissingUid;
            try wire.validate_uid(uid);
            if (self.find(uid) != null) return error.DuplicateUid;
            const slot = for (&self.apps) |*app| {
                if (app.* == null) break app;
            } else return error.SessionLimit;
            slot.* = try App.create(self.allocator, self.io, request);
            response.session = slot.*.?.status();
        },
        .list_sessions => {
            var list: std.ArrayList(wire.Status) = .empty;
            for (self.apps) |app| if (app) |value| try list.append(allocator, value.status());
            response.sessions = try list.toOwnedSlice(allocator);
        },
        .kill_server => {
            self.stopping = true;
            for (&self.apps) |*app| if (app.*) |value| {
                value.deinit();
                app.* = null;
            };
        },
        else => {
            const uid = request.uid orelse return error.MissingUid;
            try wire.validate_uid(uid);
            const index = self.find(uid) orelse return error.UnknownUid;
            const app = self.apps[index].?;
            switch (request.op) {
                .capture_pane => response.text = try app.session.capture(allocator, request.history, request.join),
                .screenshot => {
                    const path = request.path orelse return error.MissingPath;
                    if (!std.fs.path.isAbsolute(path)) return error.ExpectedAbsolutePath;
                    try protocol.screenshot(allocator, &app.session, path, request.font_size);
                    response.path = path;
                },
                .send_input => {
                    const encoded = request.base64 orelse return error.MissingInput;
                    const decoder = std.base64.standard.Decoder;
                    const input = try allocator.alloc(u8, try decoder.calcSizeForSlice(encoded));
                    try decoder.decode(input, encoded);
                    try app.send(input);
                },
                .resize_window => try app.resize(request.cols, request.rows),
                .kill_session => {
                    app.deinit();
                    self.apps[index] = null;
                    return response;
                },
                else => unreachable,
            }
            response.session = app.status();
        },
    }
    return response;
}

fn find(self: *Self, uid: []const u8) ?usize {
    for (self.apps, 0..) |app, i| if (app) |value| {
        if (std.mem.eql(u8, value.uid, uid)) return i;
    };
    return null;
}
