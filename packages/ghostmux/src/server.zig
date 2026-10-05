const std = @import("std");
const wire = @import("wire.zig");
const transport = @import("transport.zig");
const Channel = @import("channel.zig");
const App = @import("app.zig");
const protocol = @import("protocol.zig");
const subscription = @import("subscription.zig");
const Self = @This();

allocator: std.mem.Allocator,
io: std.Io,
renderer: @import("render.zig").Renderer,
mutex: std.Io.Mutex = .init,
apps: std.ArrayList(*App) = .empty,
clients: std.ArrayList(*Channel) = .empty,
stopping: bool = false,
accept_error: ?anyerror = null,
connected: bool = false,

pub fn run(allocator: std.mem.Allocator, io: std.Io, path: [:0]const u8, initial: ?std.Io.net.Stream) !void {
    var signals = @import("runtime_security.zig").Signals.init();
    defer signals.deinit();
    var listener = try transport.listen(allocator, io, path);
    defer listener.cleanup(io, path);
    var self: Self = .{ .allocator = allocator, .io = io, .renderer = .init(allocator) };
    defer self.renderer.deinit();
    defer {
        for (self.clients.items) |client| client.stop();
        for (self.apps.items) |app| app.deinit();
        for (self.clients.items) |client| client.deinit();
        self.apps.deinit(allocator);
        self.clients.deinit(allocator);
    }
    if (initial) |stream| try self.insert(stream);
    var accepting: std.Io.Group = .init;
    try accepting.concurrent(io, accept_clients, .{ &self, &listener.server });
    defer accepting.cancel(io);
    var connected = initial != null;
    const startup_deadline = transport.now_ms(io) + wire.timeout_ms;
    while (true) {
        if (@import("runtime_security.zig").Signals.requested()) return;
        var retired: std.ArrayList(*Channel) = .empty;
        defer {
            for (retired.items) |channel| channel.deinit();
            retired.deinit(allocator);
        }
        const done = try self.tick(&retired, &connected, startup_deadline, listener.startup);
        if (done) return;
        try std.Io.sleep(io, .fromMilliseconds(20), .awake);
    }
}

fn accept_clients(self: *Self, listener: *std.Io.net.Server) std.Io.Cancelable!void {
    while (true) {
        const stream = listener.accept(self.io) catch |err| {
            if (err == error.Canceled) return error.Canceled;
            self.mutex.lockUncancelable(self.io);
            self.accept_error = err;
            self.mutex.unlock(self.io);
            return;
        };
        @import("runtime_security.zig").peer(stream) catch {
            stream.close(self.io);
            continue;
        };
        self.insert(stream) catch stream.close(self.io);
    }
}

fn insert(self: *Self, stream: std.Io.net.Stream) !void {
    try self.mutex.lock(self.io);
    defer self.mutex.unlock(self.io);
    if (self.stopping) return error.ServerShuttingDown;
    try self.clients.ensureUnusedCapacity(self.allocator, 1);
    const channel = try Channel.init(self.allocator, self.io, stream);
    errdefer self.allocator.destroy(channel);
    try channel.start(self, dispatch_channel);
    self.clients.appendAssumeCapacity(channel);
    self.connected = true;
}

fn tick(self: *Self, retired: *std.ArrayList(*Channel), connected: *bool, startup_deadline: i64, startup: std.Io.File) !bool {
    try self.mutex.lock(self.io);
    defer self.mutex.unlock(self.io);
    if (self.accept_error) |err| return err;
    try self.refresh_apps();
    try retired.ensureUnusedCapacity(self.allocator, self.clients.items.len);
    var index: usize = 0;
    while (index < self.clients.items.len) {
        const channel = self.clients.items[index];
        if (!channel.closed.load(.acquire)) {
            if (self.stopping) channel.closing = true;
            channel.sync_closing();
        }
        if (channel.closed.load(.acquire) or (self.stopping and !channel.handled.load(.acquire)) or transport.now_ms(self.io) >= channel.deadline.load(.acquire)) {
            for (self.apps.items) |app| {
                app.mutex.lockUncancelable(self.io);
                app.remove_observer(channel);
                app.mutex.unlock(self.io);
            }
            retired.appendAssumeCapacity(self.clients.swapRemove(index));
        } else index += 1;
    }
    const has_clients = self.clients.items.len != 0;
    const has_apps = self.apps.items.len != 0;
    connected.* = connected.* or has_clients or self.connected;
    if (!has_clients and (self.stopping or (!has_apps and connected.*))) {
        if (!try startup.tryLock(self.io, .exclusive)) return false;
        self.stopping = true;
        return true;
    }
    if (!connected.* and transport.now_ms(self.io) >= startup_deadline) return error.StartupTimeout;
    return false;
}

fn refresh_apps(self: *Self) !void {
    for (self.apps.items) |value| {
        value.step() catch |err| {
            value.mutex.lockUncancelable(self.io);
            value.failure = err;
            value.mutex.unlock(self.io);
            value.terminate(255);
        };
        try value.persist_final_status();
    }
    self.pump_clients();
    var index: usize = 0;
    while (index < self.apps.items.len) {
        const app = self.apps.items[index];
        try app.mutex.lock(self.io);
        const done = app.status().exit_code != null;
        app.mutex.unlock(self.io);
        if (done) {
            _ = self.apps.swapRemove(index);
            app.deinit();
        } else index += 1;
    }
}

fn pump_clients(self: *Self) void {
    for (self.clients.items) |channel| {
        if (!channel.closed.load(.acquire)) {
            subscription.pump(channel, self.apps.items) catch |err| {
                channel.closing = true;
                channel.respond(.{ .ok = false, .server_pid = wire.process_id(), .event = "error", .error_name = @errorName(err) }) catch channel.closed.store(true, .release);
            };
            channel.sync_closing();
        }
    }
}

fn dispatch_channel(context: *anyopaque, channel: *Channel, body: []const u8) !void {
    const self: *Self = @ptrCast(@alignCast(context));
    try self.mutex.lock(self.io);
    defer self.mutex.unlock(self.io);
    try self.refresh_apps();
    var arena = std.heap.ArenaAllocator.init(self.allocator);
    defer arena.deinit();
    var response = self.dispatch(arena.allocator(), body, channel) catch |err| wire.Response{
        .ok = false,
        .error_name = @errorName(err),
        .server_pid = wire.process_id(),
    };
    if (!channel.subscribed or !response.ok) {
        if (channel.subscribed) {
            response.event = "error";
            channel.closing = true;
            channel.sync_closing();
        }
        try channel.respond(response);
    }
    channel.handled.store(true, .release);
}

fn dispatch(self: *Self, allocator: std.mem.Allocator, body: []const u8, client: *Channel) !wire.Response {
    const request = try std.json.parseFromSliceLeaky(wire.Request, allocator, body, .{});
    if (request.version != wire.protocol_version) return error.ProtocolVersionMismatch;
    if (request.subscribe and request.op != .new_session) return error.UnexpectedOption;
    if (request.status_path != null and request.op != .new_session) return error.UnexpectedOption;
    if (request.signal != null and request.op != .signal_session) return error.UnexpectedOption;
    if (!request.is_pty and request.op != .new_session) return error.UnexpectedOption;
    if (self.stopping) return error.ServerShuttingDown;
    var response: wire.Response = .{ .server_pid = wire.process_id() };
    switch (request.op) {
        .new_session => {
            const uid = request.uid orelse return error.MissingUid;
            try wire.validate_uid(uid);
            if (self.find(uid) != null) return error.DuplicateUid;
            try self.apps.ensureUnusedCapacity(self.allocator, 1);
            const app = try App.create(self.allocator, self.io, request);
            self.apps.appendAssumeCapacity(app);
            errdefer {
                _ = self.apps.pop();
                app.deinit();
            }
            if (request.subscribe) try subscription.prepare_launch(client, app);
            try app.spawn(request);
            if (request.subscribe) try subscription.acknowledge_launch(client, app);
            self.pump_clients();
            app.start() catch |err| {
                app.mutex.lockUncancelable(self.io);
                app.failure = err;
                app.mutex.unlock(self.io);
                return err;
            };
            try app.mutex.lock(self.io);
            response.session = app.status();
            app.mutex.unlock(self.io);
        },
        .list_sessions => {
            var list: std.ArrayList(wire.Status) = .empty;
            for (self.apps.items) |value| {
                try value.mutex.lock(self.io);
                defer value.mutex.unlock(self.io);
                try list.append(allocator, value.status());
            }
            response.sessions = try list.toOwnedSlice(allocator);
        },
        .subscribe_output => try subscription.start(client, request, self.apps.items),
        .kill_server => {
            self.stopping = true;
            for (self.apps.items) |value| value.terminate(137);
        },
        else => {
            const uid = request.uid orelse return error.MissingUid;
            try wire.validate_uid(uid);
            const index = self.find(uid) orelse return error.UnknownUid;
            const app = self.apps.items[index];
            if (request.op == .kill_session) {
                app.terminate(137);
                try app.persist_final_status();
                self.pump_clients();
                app.mutex.lockUncancelable(self.io);
                var status = app.status();
                app.mutex.unlock(self.io);
                status.uid = try allocator.dupe(u8, status.uid);
                response.session = status;
                _ = self.apps.swapRemove(index);
                app.deinit();
                return response;
            }
            try app.mutex.lock(self.io);
            defer app.mutex.unlock(self.io);
            switch (request.op) {
                .signal_session => try app.process.?.signal(request.signal orelse return error.MissingSignal),
                .read_output => {
                    response = try app.output.read(allocator, request.offset, request.limit);
                    response.server_pid = wire.process_id();
                    response.uid = app.uid;
                },
                .capture_pane => response.text = try (try app.terminal()).capture(allocator, request.history, request.join),
                .screenshot => {
                    const path = request.path orelse return error.MissingPath;
                    if (!std.fs.path.isAbsolute(path)) return error.ExpectedAbsolutePath;
                    try protocol.screenshot(self.io, &self.renderer, try app.terminal(), path, request.font_size);
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
                else => unreachable,
            }
            response.session = app.status();
        },
    }
    return response;
}

fn find(self: *Self, uid: []const u8) ?usize {
    for (self.apps.items, 0..) |value, i| {
        if (std.mem.eql(u8, value.uid, uid)) return i;
    }
    return null;
}
