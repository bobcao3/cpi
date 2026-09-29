const std = @import("std");
const wire = @import("wire.zig");
const App = @import("app.zig");
const Channel = @import("channel.zig");

pub fn start(client: *Channel, request: wire.Request, apps: []const *App) !void {
    if (request.uid) |uid| {
        try wire.validate_uid(uid);
        const app = for (apps) |entry| {
            if (std.mem.eql(u8, uid, entry.uid)) break entry;
        } else return error.UnknownUid;
        app.mutex.lockUncancelable(app.io);
        defer app.mutex.unlock(app.io);
        if (request.offset < app.output.first()) return error.OutputExpired;
        if (request.offset > app.output.end) return error.InvalidOffset;
        client.subscription_uid = try client.allocator.dupe(u8, uid);
        client.subscription_offset = request.offset;
        try acknowledge(client);
        try bind(client, app);
    } else {
        if (request.offset != 0) return error.InvalidOffset;
        try acknowledge(client);
        try pump(client, apps);
    }
}

fn acknowledge(client: *Channel) !void {
    try client.respond(.{ .server_pid = wire.process_id(), .event = "subscribed" });
    client.subscribed = true;
}

pub fn prepare_launch(client: *Channel, app: *App) !void {
    std.debug.assert(app.process == null and app.output.end == 0);
    client.subscription_uid = try client.allocator.dupe(u8, app.uid);
    _ = try app.add_observer(client, send_live, output_ready);
}

pub fn acknowledge_launch(client: *Channel, app: *App) !void {
    try client.respond(.{ .server_pid = wire.process_id(), .event = "subscribed", .uid = app.uid, .session = app.status(), .offset = 0, .next_offset = 0 });
    client.subscribed = true;
}

pub fn pump(client: *Channel, apps: []const *App) !void {
    if (!client.subscribed or client.closing) return;
    for (apps) |app| {
        if (client.subscription_uid) |uid| if (!std.mem.eql(u8, uid, app.uid)) continue;
        app.mutex.lockUncancelable(app.io);
        defer app.mutex.unlock(app.io);
        if (app.observer(client) == null) try bind(client, app);
        const observer = app.observer(client).?;
        if (observer.completed or !app.drained) continue;
        try client.respond(.{ .server_pid = wire.process_id(), .event = "exit", .uid = app.uid, .session = app.status(), .offset = app.output.end, .next_offset = app.output.end, .eof = true, .error_name = if (app.failure) |err| @errorName(err) else null });
        observer.completed = true;
        if (client.subscription_uid != null) client.closing = true;
    }
}

fn bind(client: *Channel, app: *App) !void {
    std.debug.assert(app.observer(client) == null);
    const offset = if (client.subscription_uid != null) client.subscription_offset else app.output.first();
    _ = try app.add_observer(client, send_live, output_ready);
    errdefer app.remove_observer(client);
    try client.replay(app.uid, &app.output, offset);
}

fn send_live(context: *anyopaque, frame: *@import("runtime_frames.zig").Shared) !void {
    const client: *Channel = @ptrCast(@alignCast(context));
    if (client.closed.load(.acquire) or client.finish.load(.acquire)) return error.ConnectionClosed;
    errdefer {
        client.closed.store(true, .release);
        client.ready.set(client.io);
    }
    try client.enqueue(frame);
}

fn output_ready(context: *anyopaque) bool {
    const client: *Channel = @ptrCast(@alignCast(context));
    return client.output_ready();
}
