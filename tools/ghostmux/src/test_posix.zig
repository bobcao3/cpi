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
        if (std.mem.indexOf(u8, value, ") Z ") != null) return;
        try f.pause();
    }
    return error.ChildStillAlive;
}

test "POSIX signals reach process group and preserve unrelated sessions" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const created = try fixture.launch("signals", true, "import os,signal,time\nsignal.signal(signal.SIGUSR1,lambda *a: os.write(1,b'USR1'))\nos.write(1,b'ready')\nwhile True: time.sleep(1)");
    defer created.deinit();
    const ready = try fixture.wait_text("signals", "ready");
    defer ready.deinit();
    const signal = try fixture.exchange(.{ .op = .signal_session, .uid = "signals", .signal = "SIGUSR1" });
    defer signal.deinit();
    try expect(signal.value.ok);
    const received = try fixture.wait_text("signals", "USR1");
    defer received.deinit();
    try expect(received.value.session.?.exit_code == null);
    const sibling = try fixture.launch("sibling", false, "import time; time.sleep(120)");
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
            const child_path = try fixture.path("child");
            defer f.allocator.free(child_path);
            const status_path = try fixture.path("status.json");
            defer f.allocator.free(status_path);
            const code = try std.fmt.allocPrint(f.allocator, "import os,time\nchild=os.fork()\nif child==0:\n while True: time.sleep(1)\nopen({f},'w').write(str(child))\nos.write(1,b'ready')\n{s}", .{ std.json.fmt(child_path, .{}), if (leader_exit) "os._exit(9)" else "time.sleep(120)" });
            defer f.allocator.free(code);
            const created = try fixture.request(&.{ "new-session", "--uid", "family", "--is-pty", if (pty) "true" else "false", "--status-path", status_path, "--", f.python, "-c", code });
            defer created.deinit();
            var child_pid: i32 = 0;
            for (0..400) |_| {
                const bytes = fixture.read_file("child") catch {
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
    const first = try fixture.launch("first", false, "import time; time.sleep(120)");
    defer first.deinit();
    const server_pid = first.value.server_pid;
    try std.posix.kill(server_pid, std.posix.SIG.KILL);
    try gone(server_pid);
    defer std.posix.kill(first.value.session.?.pid, std.posix.SIG.KILL) catch {};
    const restarted = try fixture.launch("second", false, "import time; time.sleep(120)");
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
    const keeper = try fixture.launch("keeper", false, "import time; time.sleep(120)");
    defer keeper.deinit();
    const python = try f.run(&.{ f.python, "-c", "import sys; print(sys.executable)" });
    defer f.free_result(python);
    try f.success(python);
    const alias = try fixture.path("custom-python");
    defer f.allocator.free(alias);
    try std.Io.Dir.cwd().symLink(f.io, std.mem.trim(u8, python.stdout, "\r\n"), alias, .{});
    const env_path = try std.fmt.allocPrint(f.allocator, "PATH={s}", .{fixture.directory});
    defer f.allocator.free(env_path);
    for ([_]bool{ false, true }) |pty| {
        const stream = try fixture.connect();
        defer stream.close(f.io);
        const created = try f.Channel.exchange(f.allocator, f.io, stream, .{ .op = .new_session, .uid = if (pty) "env-pty" else "env-pipe", .is_pty = pty, .subscribe = true, .cwd = fixture.directory, .env = &.{ env_path, "CUSTOM=value" }, .argv = &.{ "custom-python", "-c", "import os; os.write(1,(os.getcwd()+'|'+os.environ['CUSTOM']+'|'+str(os.isatty(0))).encode())" } });
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
