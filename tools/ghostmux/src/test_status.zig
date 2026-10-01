const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

test "failed final status replacement stops daemon and preserves prior status" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const path = try fixture.path("status.json");
    defer f.allocator.free(path);
    const initial_path = try fixture.path("initial.json");
    defer f.allocator.free(initial_path);
    const gate = try fixture.path("failure/release");
    defer f.allocator.free(gate);
    const target = try fixture.launch(.{ .op = .new_session, .uid = "failure", .status_path = path, .is_pty = false }, .{ .program = .replay });
    defer target.deinit();
    const sibling_path = try fixture.path("sibling.json");
    defer f.allocator.free(sibling_path);
    const sibling = try fixture.launch(.{ .op = .new_session, .uid = "sibling", .status_path = sibling_path, .is_pty = false }, .{});
    defer sibling.deinit();
    try std.Io.Dir.renameAbsolute(path, initial_path, f.io);
    try std.Io.Dir.createDirAbsolute(f.io, path, if (f.windows) .default_dir else .fromMode(0o700));
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = gate, .data = "release" });
    try @import("test_lifecycle.zig").socket_gone(&fixture);
    const bytes = try fixture.read_file("initial.json");
    defer f.allocator.free(bytes);
    const initial = try std.json.parseFromSlice(f.wire.Response, f.allocator, bytes, .{});
    defer initial.deinit();
    try expect(initial.value.session.?.exit_code == null);
    var directory = try std.Io.Dir.openDirAbsolute(f.io, fixture.directory, .{ .iterate = true });
    defer directory.close(f.io);
    var iterator = directory.iterate();
    var count: usize = 0;
    while (try iterator.next(f.io)) |entry| {
        count += 1;
        try expect(count <= 32);
        try expect(!std.mem.endsWith(u8, entry.name, ".tmp"));
    }
    if (@import("builtin").os.tag == .linux) {
        for ([_]i32{ target.value.session.?.pid, sibling.value.session.?.pid }) |pid| {
            var buffer: [64]u8 = undefined;
            const proc = try std.fmt.bufPrint(&buffer, "/proc/{d}", .{pid});
            try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(f.io, proc, .{}));
        }
    }
}

test "launches during idle retirement preserve immediate output and persisted completion" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    for (0..12) |i| {
        var uid_buffer: [32]u8 = undefined;
        const uid = try std.fmt.bufPrint(&uid_buffer, "retirement-{d}", .{i});
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "status-{d}.json", .{i});
        const path = try fixture.path(name);
        defer f.allocator.free(path);
        const created = try fixture.launch(.{ .op = .new_session, .uid = uid, .status_path = path, .is_pty = false }, .{ .program = .emit, .output = "complete" });
        defer created.deinit();
        try expect(created.value.ok);
    }
    for (0..12) |i| {
        var name_buffer: [32]u8 = undefined;
        const final = try @import("test_lifecycle.zig").status(&fixture, try std.fmt.bufPrint(&name_buffer, "status-{d}.json", .{i}), 7);
        defer final.deinit();
        try std.testing.expectEqual(@as(u64, 8), final.value.session.?.bytes);
    }
    try @import("test_lifecycle.zig").socket_gone(&fixture);
}
