const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

test "pipe binary stdout stderr, stdin EOF and reconnect preserve bytes and offsets" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const log = try fixture.path("output.log");
    defer f.allocator.free(log);
    const release = try fixture.path("pipe/release");
    defer f.allocator.free(release);
    const created = try fixture.launch(.{ .op = .new_session, .uid = "pipe", .is_pty = false, .log_path = log }, .{ .program = .pipe_eof });
    defer created.deinit();
    try expect(!created.value.session.?.is_pty and created.value.session.?.exit_code == null);
    const ready = try fixture.wait_bytes("pipe", 10);
    defer ready.deinit();
    const first = try fixture.exchange(.{ .op = .read_output, .uid = "pipe", .limit = 3 });
    defer first.deinit();
    const bytes = try f.decode(first.value);
    defer f.allocator.free(bytes);
    try std.testing.expectEqualStrings("OUT", bytes);
    try std.testing.expectEqual(@as(u64, 3), first.value.next_offset.?);
    for ([_]f.wire.Request{ .{ .op = .capture_pane, .uid = "pipe" }, .{ .op = .resize_window, .uid = "pipe", .cols = 20, .rows = 4 } }) |request| {
        const rejected = try fixture.exchange(request);
        defer rejected.deinit();
        try f.expect_error(rejected.value, "NotPty");
    }
    const stream = try fixture.connect();
    defer stream.close(f.io);
    const subscribed = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .subscribe_output, .uid = "pipe", .offset = 3 });
    defer subscribed.deinit();
    try std.testing.expectEqualStrings("subscribed", subscribed.value.event.?);
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 3;
    const replay = try f.next(stream);
    defer replay.deinit();
    try append_output(&actual, replay.value, &offset);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = release, .data = "" });
    var exited = false;
    for (0..100) |_| {
        const response = try f.next(stream);
        defer response.deinit();
        if (std.mem.eql(u8, response.value.event.?, "exit")) {
            try std.testing.expectEqual(@as(?i32, 7), response.value.session.?.exit_code);
            try std.testing.expectEqual(@as(u64, 13), response.value.session.?.bytes);
            exited = true;
            break;
        }
        try append_output(&actual, response.value, &offset);
    }
    try expect(exited);
    try std.testing.expectEqualStrings("\x00\xffERR\x00\xfeEOF", actual.items);
    const logged = try fixture.read_file("output.log");
    defer f.allocator.free(logged);
    try std.testing.expectEqualStrings("OUT\x00\xffERR\x00\xfeEOF", logged);
}

pub fn append_output(actual: *std.ArrayList(u8), response: f.wire.Response, offset: *u64) !void {
    try expect(response.ok);
    try std.testing.expectEqualStrings("data", response.event.?);
    try std.testing.expectEqual(offset.*, response.offset.?);
    const bytes = try f.decode(response);
    defer f.allocator.free(bytes);
    try actual.appendSlice(f.allocator, bytes);
    offset.* += bytes.len;
    try std.testing.expectEqual(offset.*, response.next_offset.?);
}

test "PTY input and resize reach the real child and preserve sibling sessions" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const created = try fixture.launch(.{ .op = .new_session, .uid = "pty", .cols = 31, .rows = 8 }, .{ .program = .echo });
    defer created.deinit();
    const initial = try fixture.wait_text("pty", "SIZE 31 8");
    defer initial.deinit();
    const sibling = try fixture.launch(.{ .op = .new_session, .uid = "sibling", .is_pty = false }, .{ .output = "ready" });
    defer sibling.deinit();
    const resized = try fixture.exchange(.{ .op = .resize_window, .uid = "pty", .cols = 47, .rows = 11 });
    defer resized.deinit();
    try expect(resized.value.ok);
    const geometry = try fixture.wait_text("pty", "SIZE 47 11");
    defer geometry.deinit();
    try std.testing.expectEqual(@as(u16, 47), geometry.value.session.?.cols);
    try std.testing.expectEqual(@as(u16, 11), geometry.value.session.?.rows);
    try fixture.send("pty", "hello\n");
    const input = try fixture.wait_text("pty", "GOT:hello");
    defer input.deinit();
    const killed = try fixture.exchange(.{ .op = .kill_session, .uid = "pty" });
    defer killed.deinit();
    try expect(killed.value.ok);
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try std.testing.expectEqual(@as(usize, 1), listed.value.sessions.?.len);
    try std.testing.expectEqualStrings("sibling", listed.value.sessions.?[0].uid);
    try expect(listed.value.sessions.?[0].exit_code == null);
}

test "wire validation rejects bad launch and version without losing control service" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const created = try fixture.launch(.{ .op = .new_session, .uid = "keeper", .is_pty = false }, .{ .output = "ready" });
    defer created.deinit();
    for ([_]struct { request: f.wire.Request, name: []const u8 }{
        .{ .request = .{ .op = .new_session, .uid = "empty" }, .name = "InvalidArguments" },
        .{ .request = .{ .op = .new_session, .uid = "bad uid", .argv = &.{f.child(.hold)} }, .name = "InvalidUid" },
        .{ .request = .{ .op = .new_session, .uid = "missing", .cwd = fixture.directory, .env = &.{"PATH=/usr/bin:/bin"}, .argv = &.{"missing-ghostmux-executable"} }, .name = "ExecutableNotFound" },
        .{ .request = .{ .op = .list_sessions, .version = 99 }, .name = "ProtocolVersionMismatch" },
        .{ .request = .{ .op = .read_output, .uid = "keeper", .limit = 0 }, .name = "InvalidReadLimit" },
    }) |case| {
        const response = try fixture.exchange(case.request);
        defer response.deinit();
        try f.expect_error(response.value, case.name);
    }
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try std.testing.expectEqual(@as(usize, 1), listed.value.sessions.?.len);
}

test "twenty-four pipe and PTY sessions retain independent output" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    var names: [24][16]u8 = undefined;
    for (&names, 0..) |*name, i| {
        const uid = try std.fmt.bufPrint(name, "session-{d}", .{i});
        var code: [128]u8 = undefined;
        const created = try fixture.launch(.{ .op = .new_session, .uid = uid, .is_pty = i % 2 == 0 }, .{ .output = try std.fmt.bufPrint(&code, "output-{d}", .{i}) });
        defer created.deinit();
        var needle: [32]u8 = undefined;
        const expected = try std.fmt.bufPrint(&needle, "output-{d}", .{i});
        const ready = if (i % 2 == 0) try fixture.wait_text(uid, expected) else try fixture.wait_bytes(uid, expected.len);
        defer ready.deinit();
        const output = try fixture.exchange(.{ .op = .read_output, .uid = uid });
        defer output.deinit();
        const bytes = try f.decode(output.value);
        defer f.allocator.free(bytes);
        try f.expect_output(expected, bytes, i % 2 == 0);
    }
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try std.testing.expectEqual(@as(usize, 24), listed.value.sessions.?.len);
}
