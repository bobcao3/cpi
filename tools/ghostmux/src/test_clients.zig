const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

const Launch = struct {
    response: ?f.Parsed = null,
    failure: ?anyerror = null,
};

fn launch(fixture: *f.Fixture, result: *Launch, index: usize) void {
    var buffer: [32]u8 = undefined;
    const uid = std.fmt.bufPrint(&buffer, "concurrent-{d}", .{index}) catch unreachable;
    const directory = fixture.prepare(uid, "ready") catch |err| {
        result.failure = err;
        return;
    };
    defer f.allocator.free(directory);
    result.response = fixture.cli_request(&.{ "new-session", "--uid", uid, "--is-pty", "false", "--cwd", directory, "--json", "--", f.child(.hold) }) catch |err| {
        result.failure = err;
        return;
    };
}

test "concurrent CLI clients auto-start one daemon and retain independent sessions" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    var results = [_]Launch{.{}} ** 8;
    defer for (results) |result| {
        if (result.response) |response| response.deinit();
    };
    var group: std.Io.Group = .init;
    defer group.cancel(f.io);
    for (&results, 0..) |*result, index| try group.concurrent(f.io, launch, .{ &fixture, result, index });
    try group.await(f.io);
    var server_pid: i32 = 0;
    for (results, 0..) |result, index| {
        if (result.failure) |err| return err;
        try expect(result.response != null);
        const response = result.response.?.value;
        var name: [32]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(&name, "concurrent-{d}", .{index}), response.session.?.uid);
        try expect(response.ok and response.session.?.exit_code == null);
        if (server_pid == 0) server_pid = response.server_pid;
        try std.testing.expectEqual(server_pid, response.server_pid);
    }
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try expect(listed.value.ok and listed.value.sessions.?.len == results.len);
    for (listed.value.sessions.?, 0..) |session, i| {
        for (listed.value.sessions.?[0..i]) |prior| try expect(prior.pid != session.pid);
    }
}

test "CLI JSON subscriptions replay retained bytes before final data and exit" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const gate = try fixture.path("cli/release");
    defer f.allocator.free(gate);
    const created = try fixture.launch(.{ .op = .new_session, .uid = "cli", .is_pty = false }, .{ .program = .replay, .output = "initial\x00\xff" });
    defer created.deinit();
    const ready = try fixture.wait_bytes("cli", 9);
    defer ready.deinit();
    var child = try std.process.spawn(f.io, .{ .argv = &.{ f.binary, "-S", fixture.socket, "subscribe-output", "--uid", "cli", "--json" }, .stdin = .ignore, .stdout = .pipe, .stderr = .ignore });
    defer child.kill(f.io);
    var buffer: [131072]u8 = undefined;
    var reader = child.stdout.?.readerStreaming(f.io, &buffer);
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 0;
    var ack = false;
    var released = false;
    var exited = false;
    for (0..100) |_| {
        const line = try bounded_line(&reader.interface) orelse return error.SubscriptionEnded;
        const response = try std.json.parseFromSlice(f.wire.Response, f.allocator, line, .{});
        defer response.deinit();
        try expect(response.value.ok);
        if (std.mem.eql(u8, response.value.event.?, "subscribed")) {
            try expect(!ack and !released);
            ack = true;
        } else if (std.mem.eql(u8, response.value.event.?, "exit")) {
            try expect(ack and released);
            try std.testing.expectEqual(@as(?i32, 7), response.value.session.?.exit_code);
            exited = true;
            break;
        } else {
            try expect(ack);
            try @import("test_daemon.zig").append_output(&actual, response.value, &offset);
            if (!released and offset == 9) {
                try std.testing.expectEqualStrings("initial\x00\xff", actual.items);
                try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = gate, .data = "release" });
                released = true;
            }
        }
    }
    try expect(exited);
    try std.testing.expectEqualStrings("initial\x00\xfftail", actual.items);
    const term = try child.wait(f.io);
    try expect(term == .exited and term.exited == 0);
}

const Result = union(enum) {
    line: anyerror!?[]const u8,
    timeout: std.Io.Cancelable!void,
};

fn bounded_line(reader: *std.Io.Reader) !?[]const u8 {
    var results: [2]Result = undefined;
    var select = std.Io.Select(Result).init(f.io, &results);
    defer while (select.cancel()) |_| {};
    try select.concurrent(.line, read_line, .{reader});
    try select.concurrent(.timeout, delay, .{});
    return switch (try select.await()) {
        .line => |value| value,
        .timeout => error.SubscriptionDeadline,
    };
}

fn read_line(reader: *std.Io.Reader) anyerror!?[]const u8 {
    return reader.takeDelimiter('\n');
}

fn delay() std.Io.Cancelable!void {
    try std.Io.sleep(f.io, .fromSeconds(10), .awake);
}
