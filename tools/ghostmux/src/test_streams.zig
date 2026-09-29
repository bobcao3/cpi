const std = @import("std");
const f = @import("test_fixture.zig");
const append_output = @import("test_daemon.zig").append_output;
const expect = std.testing.expect;

fn subscribe(fixture: *f.Fixture, uid: ?[]const u8, offset: u64) !std.Io.net.Stream {
    const stream = try fixture.connect();
    errdefer stream.close(f.io);
    const response = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .subscribe_output, .uid = uid, .offset = offset });
    defer response.deinit();
    try expect(response.value.ok);
    try std.testing.expectEqualStrings("subscribed", response.value.event.?);
    return stream;
}

test "atomic wire launch streams immediate binary output and exit beyond retained ring" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch("keeper", false, "import time; time.sleep(120)");
    defer keeper.deinit();
    const stream = try fixture.connect();
    defer stream.close(f.io);
    const response = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .new_session, .uid = "atomic", .cwd = fixture.directory, .is_pty = false, .subscribe = true, .argv = &.{ f.python, "-c", "import os; data=b'0123456789abcdef'*131072\nwhile data: data=data[os.write(1,data):]\nos._exit(9)" } });
    defer response.deinit();
    try expect(response.value.ok);
    try std.testing.expectEqualStrings("subscribed", response.value.event.?);
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 0;
    var exited = false;
    for (0..1024) |_| {
        const next = try f.next(stream);
        defer next.deinit();
        if (std.mem.eql(u8, next.value.event.?, "exit")) {
            try std.testing.expectEqual(@as(?i32, 9), next.value.session.?.exit_code);
            try std.testing.expectEqual(@as(u64, 2 * 1024 * 1024), next.value.session.?.bytes);
            exited = true;
            break;
        }
        try append_output(&actual, next.value, &offset);
    }
    try expect(exited and actual.items.len == 2 * 1024 * 1024);
    for (actual.items, 0..) |byte, i| try std.testing.expectEqual("0123456789abcdef"[i % 16], byte);
}

test "expired ring offsets reject while retained tail replays before final output and exit" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const release_path = try std.fmt.allocPrint(f.allocator, "{s}/release", .{fixture.directory});
    defer f.allocator.free(release_path);
    const code = try std.fmt.allocPrint(f.allocator, "import os,time\nrelease={f}\ndata=b'0123456789abcdef'*131072\nwhile data: data=data[os.write(1,data):]\nwhile not os.path.exists(release): time.sleep(0.01)\nos.write(1,b'tail'); os._exit(3)", .{std.json.fmt(release_path, .{})});
    defer f.allocator.free(code);
    const created = try fixture.launch("ring", false, code);
    defer created.deinit();
    const ready = try fixture.wait_bytes("ring", 2 * 1024 * 1024);
    defer ready.deinit();
    const expired = try fixture.exchange(.{ .op = .read_output, .uid = "ring" });
    defer expired.deinit();
    try f.expect_error(expired.value, "OutputExpired");
    const stream = try subscribe(&fixture, "ring", 2 * 1024 * 1024 - 65536);
    defer stream.close(f.io);
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 2 * 1024 * 1024 - 65536;
    const replay = try f.next(stream);
    defer replay.deinit();
    try append_output(&actual, replay.value, &offset);
    try std.testing.expectEqual(@as(usize, 65536), actual.items.len);
    for (actual.items, 0..) |byte, i| try std.testing.expectEqual("0123456789abcdef"[i % 16], byte);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = release_path, .data = "" });
    var exited = false;
    for (0..100) |_| {
        const response = try f.next(stream);
        defer response.deinit();
        if (std.mem.eql(u8, response.value.event.?, "exit")) {
            try std.testing.expectEqual(@as(?i32, 3), response.value.session.?.exit_code);
            exited = true;
            break;
        }
        try append_output(&actual, response.value, &offset);
    }
    try expect(exited);
    try std.testing.expectEqualStrings("tail", actual.items[65536..]);
}

test "multiplex subscriptions include future sessions and UID reuse" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch("keeper", false, "import time; time.sleep(120)");
    defer keeper.deinit();
    const stream = try subscribe(&fixture, null, 0);
    defer stream.close(f.io);
    for (0..2) |_| {
        const created = try fixture.launch("reused", false, "import os; os.write(1,b'new'); os._exit(7)");
        defer created.deinit();
        var actual: std.ArrayList(u8) = .empty;
        defer actual.deinit(f.allocator);
        var offset: u64 = 0;
        var exited = false;
        for (0..100) |_| {
            const response = try f.next(stream);
            defer response.deinit();
            try std.testing.expectEqualStrings("reused", response.value.uid.?);
            if (std.mem.eql(u8, response.value.event.?, "exit")) {
                try std.testing.expectEqual(@as(?i32, 7), response.value.session.?.exit_code);
                exited = true;
                break;
            }
            try append_output(&actual, response.value, &offset);
        }
        try expect(exited);
        try std.testing.expectEqualStrings("new", actual.items);
    }
}

test "blocked and disconnected subscribers do not block control or corrupt shared live frames" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const start_path = try std.fmt.allocPrint(f.allocator, "{s}/start", .{fixture.directory});
    defer f.allocator.free(start_path);
    const finish_path = try std.fmt.allocPrint(f.allocator, "{s}/finish", .{fixture.directory});
    defer f.allocator.free(finish_path);
    const code = try std.fmt.allocPrint(f.allocator, "import os,time\nstart={f}; finish={f}\nwhile not os.path.exists(start): time.sleep(0.01)\ndata=b'abcdefgh'*262144\nwhile data: data=data[os.write(1,data):]\nwhile not os.path.exists(finish): time.sleep(0.01)", .{ std.json.fmt(start_path, .{}), std.json.fmt(finish_path, .{}) });
    defer f.allocator.free(code);
    const created = try fixture.launch("producer", false, code);
    defer created.deinit();
    const blocked = try subscribe(&fixture, "producer", 0);
    defer blocked.close(f.io);
    const disconnected = try subscribe(&fixture, "producer", 0);
    defer disconnected.close(f.io);
    const live = try subscribe(&fixture, "producer", 0);
    defer live.close(f.io);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = start_path, .data = "" });
    const ready = try fixture.wait_bytes("producer", 1024 * 1024);
    defer ready.deinit();
    const control_started = @import("transport.zig").now_ms(f.io);
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try expect(listed.value.ok and listed.value.sessions.?.len == 1);
    try expect(@import("transport.zig").now_ms(f.io) - control_started < 2000);
    try blocked.shutdown(f.io, .both);
    try disconnected.shutdown(f.io, .both);
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 0;
    for (0..1024) |_| {
        if (offset == 2 * 1024 * 1024) break;
        const response = f.next(live) catch |err| {
            std.debug.print("Live subscriber failed after {d} bytes: {s}\n", .{ offset, @errorName(err) });
            return err;
        };
        defer response.deinit();
        try append_output(&actual, response.value, &offset);
    }
    try std.testing.expectEqual(@as(u64, 2 * 1024 * 1024), offset);
    for (actual.items, 0..) |byte, i| try std.testing.expectEqual("abcdefgh"[i % 8], byte);
    const killed = try fixture.exchange(.{ .op = .kill_session, .uid = "producer" });
    defer killed.deinit();
    try expect(killed.value.ok);
    const exit = f.next(live) catch |err| {
        std.debug.print("Live subscriber did not receive termination after {d} bytes: {s}\n", .{ offset, @errorName(err) });
        return err;
    };
    defer exit.deinit();
    try std.testing.expectEqualStrings("exit", exit.value.event.?);
    try std.testing.expectEqual(@as(?i32, 137), exit.value.session.?.exit_code);
}
