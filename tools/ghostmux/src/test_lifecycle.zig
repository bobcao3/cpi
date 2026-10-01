const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

pub fn status(fixture: *f.Fixture, name: []const u8, code: i32) !f.Parsed {
    for (0..400) |_| {
        const bytes = fixture.read_file(name) catch |err| switch (err) {
            error.FileNotFound => {
                try f.pause();
                continue;
            },
            else => return err,
        };
        defer f.allocator.free(bytes);
        const parsed = try std.json.parseFromSlice(f.wire.Response, f.allocator, bytes, .{ .allocate = .alloc_always });
        if (parsed.value.session.?.exit_code == code) return parsed;
        parsed.deinit();
        try f.pause();
    }
    return error.StatusDeadline;
}

pub fn socket_gone(fixture: *f.Fixture) !void {
    for (0..400) |_| {
        _ = std.Io.Dir.cwd().statFile(f.io, fixture.socket, .{ .follow_symlinks = false }) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        try f.pause();
    }
    return error.RetirementDeadline;
}

test "detached immediate pipe and PTY persist exact logs and final status and retire" {
    for ([_]bool{ false, true }) |pty| {
        var fixture = try f.Fixture.init();
        defer fixture.deinit();
        const path = try fixture.path("status.json");
        defer f.allocator.free(path);
        const log = try fixture.path("output.log");
        defer f.allocator.free(log);
        const created = try fixture.launch(.{ .op = .new_session, .uid = "immediate", .is_pty = pty, .status_path = path, .log_path = log }, .{ .program = .emit, .output = "immediate output" });
        defer created.deinit();
        try expect(created.value.session.?.exit_code == null);
        const final = try status(&fixture, "status.json", 7);
        defer final.deinit();
        try expect(final.value.ok and final.value.error_name == null);
        try std.testing.expectEqualStrings("immediate", final.value.session.?.uid);
        try std.testing.expectEqual(created.value.server_pid, final.value.server_pid);
        try std.testing.expectEqual(created.value.session.?.pid, final.value.session.?.pid);
        const bytes = try fixture.read_file("output.log");
        defer f.allocator.free(bytes);
        try std.testing.expectEqual(@as(u64, bytes.len), final.value.session.?.bytes);
        try f.expect_output("immediate output", bytes, pty);
        try socket_gone(&fixture);
    }
}

test "startup lock permits repeated restart with reused UID after idle daemon retirement" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    var previous: i32 = 0;
    for (0..12) |_| {
        const directory = try fixture.prepare("same", "complete");
        defer f.allocator.free(directory);
        const created = try fixture.cli_request(&.{ "new-session", "--uid", "same", "--is-pty", "false", "--cwd", directory, "--json", "--", f.child(.emit) });
        defer created.deinit();
        try expect(created.value.server_pid > 0 and created.value.server_pid != previous);
        previous = created.value.server_pid;
        try socket_gone(&fixture);
    }
}

test "kill-session and kill-server persist final statuses without subscribers" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    for ([_]bool{ false, true }) |pty| {
        const name = if (pty) "pty.json" else "pipe.json";
        const uid = if (pty) "pty" else "pipe";
        const path = try fixture.path(name);
        defer f.allocator.free(path);
        const log = try fixture.path(if (pty) "pty.log" else "pipe.log");
        defer f.allocator.free(log);
        const created = try fixture.launch(.{ .op = .new_session, .uid = uid, .is_pty = pty, .status_path = path, .log_path = log }, .{ .output = "ready" });
        defer created.deinit();
        const ready = if (pty) try fixture.wait_text(uid, "ready") else try fixture.wait_bytes(uid, 5);
        defer ready.deinit();
    }
    const killed = try fixture.exchange(.{ .op = .kill_session, .uid = "pipe" });
    defer killed.deinit();
    try expect(killed.value.ok);
    const final_pipe = try status(&fixture, "pipe.json", 137);
    defer final_pipe.deinit();
    try std.testing.expectEqual(@as(u64, 5), final_pipe.value.session.?.bytes);
    const stopped = try fixture.exchange(.{ .op = .kill_server });
    defer stopped.deinit();
    const final_pty = try status(&fixture, "pty.json", 137);
    defer final_pty.deinit();
    const bytes = try fixture.read_file("pty.log");
    defer f.allocator.free(bytes);
    try std.testing.expectEqual(@as(u64, bytes.len), final_pty.value.session.?.bytes);
    try f.expect_output("ready", bytes, true);
    try socket_gone(&fixture);
}

test "existing status destinations reject launch and preserve caller files" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch(.{ .op = .new_session, .uid = "keeper", .is_pty = false }, .{});
    defer keeper.deinit();
    const path = try fixture.path("existing.json");
    defer f.allocator.free(path);
    const marker = try fixture.path("launched");
    defer f.allocator.free(marker);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = path, .data = "preserve existing bytes" });
    const rejected = try fixture.exchange(.{ .op = .new_session, .uid = "rejected", .cwd = fixture.directory, .status_path = path, .argv = &.{f.child(.marker)} });
    defer rejected.deinit();
    try f.expect_error(rejected.value, "PathAlreadyExists");
    const bytes = try fixture.read_file("existing.json");
    defer f.allocator.free(bytes);
    try std.testing.expectEqualStrings("preserve existing bytes", bytes);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(f.io, marker, .{}));
    const relative = try fixture.exchange(.{ .op = .new_session, .uid = "relative", .cwd = fixture.directory, .status_path = "relative.json", .argv = &.{f.child(.marker)} });
    defer relative.deinit();
    try f.expect_error(relative.value, "ExpectedAbsolutePath");
    const wrong = try fixture.exchange(.{ .op = .list_sessions, .status_path = path });
    defer wrong.deinit();
    try f.expect_error(wrong.value, "UnexpectedOption");
}

test "partial and malformed wire clients cannot block real control requests" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch(.{ .op = .new_session, .uid = "keeper", .is_pty = false }, .{});
    defer keeper.deinit();
    const partial = try fixture.connect();
    defer partial.close(f.io);
    var partial_writer = partial.writer(f.io, &.{});
    try partial_writer.interface.writeAll(&.{ 0, 0 });
    const malformed = try fixture.connect();
    defer malformed.close(f.io);
    var malformed_writer = malformed.writer(f.io, &.{});
    try malformed_writer.interface.writeAll(&.{ 0, 0, 0, 1, '{' });
    const rejected = try f.next(malformed);
    defer rejected.deinit();
    try expect(!rejected.value.ok);
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try expect(listed.value.ok and listed.value.sessions.?.len == 1);
    const killed = try fixture.exchange(.{ .op = .kill_session, .uid = "keeper" });
    defer killed.deinit();
    try expect(killed.value.ok);
}

test "regular socket files and symlink startup locks never get replaced" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = fixture.socket, .data = "preserve" });
    const result = try fixture.cli(&.{ "new-session", "--uid", "unsafe", "--", f.child(.marker) });
    defer f.free_result(result);
    try expect(result.term == .exited and result.term.exited != 0);
    const bytes = try fixture.read_file("s");
    defer f.allocator.free(bytes);
    try std.testing.expectEqualStrings("preserve", bytes);
    try std.Io.Dir.cwd().deleteFile(f.io, fixture.socket);
    const lock = try std.fmt.allocPrint(f.allocator, "{s}.startup", .{fixture.socket});
    defer f.allocator.free(lock);
    std.Io.Dir.cwd().deleteFile(f.io, lock) catch {};
    const target = try fixture.path("target");
    defer f.allocator.free(target);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = target, .data = "target" });
    try std.Io.Dir.cwd().symLink(f.io, target, lock, .{});
    const symlink = try fixture.cli(&.{ "new-session", "--uid", "unsafe", "--", f.child(.marker) });
    defer f.free_result(symlink);
    try expect(symlink.term == .exited and symlink.term.exited != 0);
    const preserved = try fixture.read_file("target");
    defer f.allocator.free(preserved);
    try std.testing.expectEqualStrings("target", preserved);
}
