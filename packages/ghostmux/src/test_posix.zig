const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;
const linux = @import("builtin").os.tag == .linux;

fn gone(pid: i32) !void {
    var buffer: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&buffer, "/proc/{d}/stat", .{pid});
    for (0..400) |_| {
        var bytes: [4096]u8 = undefined;
        const value = std.Io.Dir.cwd().readFile(f.io, path, &bytes) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        if (std.mem.indexOf(u8, value, ") Z ") != null) {
            var task_buffer: [64]u8 = undefined;
            const task_path = try std.fmt.bufPrint(&task_buffer, "/proc/{d}/task", .{pid});
            var tasks = std.Io.Dir.cwd().openDir(f.io, task_path, .{ .iterate = true }) catch |err| switch (err) {
                error.FileNotFound => return,
                else => return err,
            };
            defer tasks.close(f.io);
            var iterator = tasks.iterate();
            _ = try iterator.next(f.io);
            if (try iterator.next(f.io) == null) return;
        }
        try f.pause();
    }
    return error.ChildStillAlive;
}

test "POSIX signals reach process group and preserve unrelated sessions" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const created = try fixture.launch(.{ .op = .new_session, .uid = "signals" }, .{ .program = .signals });
    defer created.deinit();
    const ready = try fixture.wait_text("signals", "ready");
    defer ready.deinit();
    const signal = try fixture.exchange(.{ .op = .signal_session, .uid = "signals", .signal = "SIGUSR1" });
    defer signal.deinit();
    try expect(signal.value.ok);
    const received = try fixture.wait_text("signals", "USR1");
    defer received.deinit();
    try expect(received.value.session.?.exit_code == null);
    const sibling = try fixture.launch(.{ .op = .new_session, .uid = "sibling", .is_pty = false }, .{});
    defer sibling.deinit();
    const stream = try fixture.connect();
    defer stream.close(f.io);
    const subscribed = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .subscribe_output, .uid = "signals", .offset = received.value.session.?.bytes });
    defer subscribed.deinit();
    try expect(subscribed.value.ok);
    const terminated = try fixture.exchange(.{ .op = .signal_session, .uid = "signals", .signal = "SIGTERM" });
    defer terminated.deinit();
    try expect(terminated.value.ok);
    const exit = try f.next(stream);
    defer exit.deinit();
    try std.testing.expectEqualStrings("exit", exit.value.event.?);
    try std.testing.expectEqual(@as(?i32, 143), exit.value.session.?.exit_code);
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try expect(listed.value.ok and listed.value.sessions.?.len == 1);
    try std.testing.expectEqualStrings("sibling", listed.value.sessions.?[0].uid);
}

test "PTY and pipe termination reap descendants and leader exit bounds inherited output drainage" {
    if (!linux) return error.SkipZigTest;
    for ([_]bool{ false, true }) |pty| {
        for ([_]bool{ false, true }) |leader_exit| {
            var fixture = try f.Fixture.init();
            defer fixture.deinit();
            const status_path = try fixture.path("status.json");
            defer f.allocator.free(status_path);
            const created = try fixture.launch(.{ .op = .new_session, .uid = "family", .is_pty = pty, .status_path = status_path }, .{ .program = if (leader_exit) .family_exit else .family });
            defer created.deinit();
            var child_pid: i32 = 0;
            for (0..400) |_| {
                const bytes = fixture.read_file("family/child") catch {
                    try f.pause();
                    continue;
                };
                defer f.allocator.free(bytes);
                child_pid = std.fmt.parseInt(i32, bytes, 10) catch {
                    try f.pause();
                    continue;
                };
                break;
            }
            try expect(child_pid > 0);
            if (!leader_exit) {
                const ready = try fixture.wait_bytes("family", 5);
                defer ready.deinit();
                const killed = try fixture.exchange(.{ .op = .kill_session, .uid = "family" });
                defer killed.deinit();
                try expect(killed.value.ok);
            }
            const final = try @import("test_lifecycle.zig").status(&fixture, "status.json", if (leader_exit) 9 else 137);
            defer final.deinit();
            try std.testing.expectEqual(@as(u64, 5), final.value.session.?.bytes);
            try gone(created.value.session.?.pid);
            try gone(child_pid);
        }
    }
}

test "stale socket after daemon crash permits fresh server startup" {
    if (!linux) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const first_directory = try fixture.prepare("first", "");
    defer f.allocator.free(first_directory);
    const first = try fixture.cli_request(&.{ "new-session", "--uid", "first", "--is-pty", "false", "--cwd", first_directory, "--json", "--", f.child(.hold) });
    defer first.deinit();
    const server_pid = first.value.server_pid;
    try std.posix.kill(server_pid, std.posix.SIG.KILL);
    try gone(server_pid);
    defer std.posix.kill(first.value.session.?.pid, std.posix.SIG.KILL) catch {};
    const second_directory = try fixture.prepare("second", "");
    defer f.allocator.free(second_directory);
    const restarted = try fixture.cli_request(&.{ "new-session", "--uid", "second", "--is-pty", "false", "--cwd", second_directory, "--json", "--", f.child(.hold) });
    defer restarted.deinit();
    try expect(restarted.value.server_pid != server_pid);
    const listed = try fixture.exchange(.{ .op = .list_sessions });
    defer listed.deinit();
    try std.testing.expectEqual(@as(usize, 1), listed.value.sessions.?.len);
    try std.testing.expectEqualStrings("second", listed.value.sessions.?[0].uid);
}

test "wire PTY and pipe resolve caller PATH and cwd and preserve explicit environment" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch(.{ .op = .new_session, .uid = "keeper", .is_pty = false }, .{});
    defer keeper.deinit();
    const alias = try fixture.path("custom-child");
    defer f.allocator.free(alias);
    try std.Io.Dir.cwd().symLink(f.io, f.child(.environment), alias, .{});
    const env_path = try std.fmt.allocPrint(f.allocator, "PATH={s}", .{fixture.directory});
    defer f.allocator.free(env_path);
    for ([_]bool{ false, true }) |pty| {
        const stream = try fixture.connect();
        defer stream.close(f.io);
        const created = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .new_session, .uid = if (pty) "env-pty" else "env-pipe", .is_pty = pty, .subscribe = true, .cwd = fixture.directory, .env = &.{ env_path, "CUSTOM=value" }, .argv = &.{"custom-child"} });
        defer created.deinit();
        try expect(created.value.ok);
        var actual: std.ArrayList(u8) = .empty;
        defer actual.deinit(f.allocator);
        var offset: u64 = 0;
        var exited = false;
        for (0..100) |_| {
            const response = try f.next(stream);
            defer response.deinit();
            if (std.mem.eql(u8, response.value.event.?, "exit")) {
                try std.testing.expectEqual(@as(?i32, 0), response.value.session.?.exit_code);
                exited = true;
                break;
            }
            try @import("test_daemon.zig").append_output(&actual, response.value, &offset);
        }
        try expect(exited);
        const expected = try std.fmt.allocPrint(f.allocator, "{s}|value|{s}", .{ fixture.directory, if (pty) "True" else "False" });
        defer f.allocator.free(expected);
        try std.testing.expectEqualStrings(expected, actual.items);
    }
}
