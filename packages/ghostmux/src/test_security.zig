const std = @import("std");
const f = @import("test_fixture.zig");
const expect = std.testing.expect;

test "unsafe writable socket directories reject launch without creating a socket" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    try std.Io.Dir.cwd().setFilePermissions(f.io, fixture.directory, .fromMode(0o777), .{});
    defer std.Io.Dir.cwd().setFilePermissions(f.io, fixture.directory, .fromMode(0o700), .{}) catch {};
    const prepared = try f.run(&.{ f.binary, "prepare-runtime", fixture.directory });
    defer f.free_result(prepared);
    try expect(prepared.term == .exited and prepared.term.exited != 0);
    try expect(std.mem.indexOf(u8, prepared.stderr, "UnsafeSocketDirectory") != null);
    try std.testing.expectEqual(@as(u16, 0o777), (try std.Io.Dir.cwd().statFile(f.io, fixture.directory, .{})).permissions.toMode() & 0o777);
    const result = try fixture.cli(&.{ "new-session", "--uid", "unsafe", "--", f.child(.marker) });
    defer f.free_result(result);
    try expect(result.term == .exited and result.term.exited != 0);
    try expect(std.mem.indexOf(u8, result.stderr, "UnsafeSocketDirectory") != null);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(f.io, fixture.socket, .{}));
}

test "saturated Unix socket backlog fails bounded client connect" {
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const address = try std.Io.net.UnixAddress.init(fixture.socket);
    var server = try address.listen(f.io, .{ .kernel_backlog = 1 });
    defer server.deinit(f.io);
    const first = try address.connect(f.io);
    defer first.close(f.io);
    const second = try address.connect(f.io);
    defer second.close(f.io);
    const started = @import("transport.zig").now_ms(f.io);
    const result = try fixture.cli(&.{ "list-sessions", "--json" });
    defer f.free_result(result);
    try expect(result.term == .exited and result.term.exited != 0);
    try expect(std.mem.indexOf(u8, result.stderr, "ServerBusy") != null);
    try expect(@import("transport.zig").now_ms(f.io) - started < 3000);
}

test "symlink status destination never launches or overwrites target" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const keeper = try fixture.launch(.{ .op = .new_session, .uid = "keeper", .is_pty = false }, .{});
    defer keeper.deinit();
    const target = try fixture.path("target");
    defer f.allocator.free(target);
    const link = try fixture.path("link");
    defer f.allocator.free(link);
    const marker = try fixture.path("launched");
    defer f.allocator.free(marker);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = target, .data = "preserve" });
    try std.Io.Dir.cwd().symLink(f.io, target, link, .{});
    const rejected = try fixture.exchange(.{ .op = .new_session, .uid = "rejected", .cwd = fixture.directory, .status_path = link, .argv = &.{f.child(.marker)} });
    defer rejected.deinit();
    try f.expect_error(rejected.value, "PathAlreadyExists");
    const bytes = try fixture.read_file("target");
    defer f.allocator.free(bytes);
    try std.testing.expectEqualStrings("preserve", bytes);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(f.io, marker, .{}));
}
