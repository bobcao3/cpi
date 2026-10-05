const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

test "multiplex replay drains twenty-four full rings before concurrent final output and exits" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    var names: [24][16]u8 = undefined;
    var offsets = [_]u64{0} ** 24;
    var finished = [_]bool{false} ** 24;
    for (&names, 0..) |*name, i| {
        const uid = try std.fmt.bufPrint(name, "replay-{d}", .{i});
        const payload = try f.repeated(&.{ @intCast(i), 0, 255, 65, 10 }, 1024 * 1024);
        defer f.allocator.free(payload);
        const created = try fixture.launch(.{ .op = .new_session, .uid = uid, .is_pty = false }, .{ .program = if (i % 2 == 0) .replay else .replay_success, .output = payload });
        defer created.deinit();
        const ready = try fixture.wait_bytes(uid, 1024 * 1024);
        defer ready.deinit();
    }
    const stream = try fixture.connect();
    defer stream.close(f.io);
    const subscribed = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .subscribe_output });
    defer subscribed.deinit();
    try expect(subscribed.value.ok);
    for (0..24) |i| {
        var name: [64]u8 = undefined;
        const gate = try fixture.path(try std.fmt.bufPrint(&name, "replay-{d}/release", .{i}));
        defer f.allocator.free(gate);
        try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = gate, .data = "release" });
    }
    var remaining: usize = 24;
    for (0..1200) |_| {
        if (remaining == 0) break;
        const response = try f.next(stream);
        defer response.deinit();
        try expect(response.value.ok);
        const uid = response.value.uid.?;
        try expect(std.mem.startsWith(u8, uid, "replay-"));
        const index = try std.fmt.parseInt(usize, uid[7..], 10);
        try expect(index < 24 and !finished[index]);
        try std.testing.expectEqual(offsets[index], response.value.offset.?);
        if (std.mem.eql(u8, response.value.event.?, "exit")) {
            try expect(response.value.eof);
            try std.testing.expectEqual(@as(?i32, if (index % 2 == 0) 7 else 0), response.value.session.?.exit_code);
            try std.testing.expectEqual(@as(u64, 1024 * 1024 + 4), offsets[index]);
            try std.testing.expectEqual(offsets[index], response.value.next_offset.?);
            finished[index] = true;
            remaining -= 1;
            continue;
        }
        try std.testing.expectEqualStrings("data", response.value.event.?);
        const bytes = try f.decode(response.value);
        defer f.allocator.free(bytes);
        try expect(bytes.len > 0);
        const pattern = [_]u8{ @intCast(index), 0, 255, 65, 10 };
        for (bytes, 0..) |byte, j| {
            const position = offsets[index] + j;
            const expected = if (position < 1024 * 1024) pattern[position % 5] else "tail"[position - 1024 * 1024];
            try std.testing.expectEqual(expected, byte);
        }
        offsets[index] += bytes.len;
        try std.testing.expectEqual(offsets[index], response.value.next_offset.?);
    }
    try std.testing.expectEqual(@as(usize, 0), remaining);
}

test "atomic CLI subscription delivers immediate output and completion on fresh daemon" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const directory = try fixture.prepare("atomic-cli", "immediate\x00\xff");
    defer f.allocator.free(directory);
    const result = try fixture.cli(&.{ "new-session", "--uid", "atomic-cli", "--is-pty", "false", "--cwd", directory, "--subscribe", "--json", "--", f.child(.emit) });
    defer f.free_result(result);
    try f.success(result);
    var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
    var actual: std.ArrayList(u8) = .empty;
    defer actual.deinit(f.allocator);
    var offset: u64 = 0;
    var ack = false;
    var exit = false;
    var count: usize = 0;
    while (lines.next()) |line| {
        count += 1;
        try expect(count <= 100);
        const response = try std.json.parseFromSlice(f.wire.Response, f.allocator, line, .{});
        defer response.deinit();
        try expect(response.value.ok);
        if (std.mem.eql(u8, response.value.event.?, "subscribed")) {
            try expect(!ack and !exit and offset == 0);
            ack = true;
        } else if (std.mem.eql(u8, response.value.event.?, "exit")) {
            try expect(ack and !exit);
            try std.testing.expectEqual(@as(?i32, 7), response.value.session.?.exit_code);
            try std.testing.expectEqual(offset, response.value.session.?.bytes);
            exit = true;
        } else {
            try expect(ack and !exit);
            try @import("test_daemon.zig").append_output(&actual, response.value, &offset);
        }
    }
    try expect(ack and exit);
    try std.testing.expectEqualStrings("immediate\x00\xff", actual.items);
}
