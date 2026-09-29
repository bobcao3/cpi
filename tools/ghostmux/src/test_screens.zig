const std = @import("std");
const f = @import("test_fixture.zig");
const Image = @import("test_image.zig").Image;
const expect = std.testing.expect;

test "daemon screenshots select UID and preserve unchanged render state" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const first = try fixture.request(&.{ "new-session", "--uid", "first", "--cols", "20", "--rows", "4", "--", f.python, "-c", "import os,time; os.write(1,'\\x1b[?25l\\x1b[31m中文 😀\\x1b[0m'.encode()); time.sleep(120)" });
    defer first.deinit();
    const ready = try fixture.wait_text("first", "中文 😀");
    defer ready.deinit();
    const path = try fixture.path("frame.png");
    defer f.allocator.free(path);
    const shot = try fixture.exchange(.{ .op = .screenshot, .uid = "first", .path = path });
    defer shot.deinit();
    try expect(shot.value.ok);
    try std.testing.expectEqualStrings(path, shot.value.path.?);
    const image = try Image.load(path);
    defer image.deinit();
    try expect(image.width % 20 == 0 and image.height % 4 == 0);
    const second = try fixture.request(&.{ "new-session", "--uid", "second", "--cols", "20", "--rows", "4", "--", f.python, "-c", "import os,time; os.write(1,b'\\x1b[?25l\\x1b[32mSECOND'); time.sleep(120)" });
    defer second.deinit();
    const other_ready = try fixture.wait_text("second", "SECOND");
    defer other_ready.deinit();
    const other_shot = try fixture.exchange(.{ .op = .screenshot, .uid = "second", .path = path });
    defer other_shot.deinit();
    try expect(other_shot.value.ok);
    const other = try Image.load(path);
    defer other.deinit();
    try expect(!std.mem.eql(u8, image.pixels, other.pixels));
    const again = try fixture.exchange(.{ .op = .screenshot, .uid = "first", .path = path });
    defer again.deinit();
    try expect(again.value.ok);
    const repeated = try Image.load(path);
    defer repeated.deinit();
    try std.testing.expectEqualSlices(u8, image.pixels, repeated.pixels);
    const relative = try std.process.run(f.allocator, f.io, .{
        .argv = &.{ f.binary, "-S", fixture.socket, "screenshot", "--uid", "first", "--output", "relative.png", "--json" },
        .cwd = .{ .path = fixture.directory },
        .stdout_limit = .limited(1024 * 1024),
        .stderr_limit = .limited(1024 * 1024),
        .timeout = .{ .duration = .{ .raw = .fromSeconds(15), .clock = .awake } },
    });
    defer f.free_result(relative);
    try f.success(relative);
    const relative_reply = try std.json.parseFromSlice(f.wire.Response, f.allocator, relative.stdout, .{});
    defer relative_reply.deinit();
    const relative_path = try fixture.path("relative.png");
    defer f.allocator.free(relative_path);
    try std.testing.expectEqualStrings(relative_path, relative_reply.value.path.?);
    const relative_image = try Image.load(relative_path);
    defer relative_image.deinit();
    try std.testing.expectEqualSlices(u8, image.pixels, relative_image.pixels);
    const plain = try fixture.cli(&.{ "capture-pane", "--uid", "first" });
    defer f.free_result(plain);
    try f.success(plain);
    try std.testing.expectEqualStrings("中文 😀\n", plain.stdout);
}

test "POSIX terminal queries match cursor and screenshot cell and ioctl pixel geometry" {
    if (f.windows) return error.SkipZigTest;
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const code =
        \\import os,tty,fcntl,termios,struct,json
        \\tty.setraw(0)
        \\def query(sequence,end):
        \\ os.write(1,sequence)
        \\ reply=b''
        \\ for _ in range(128):
        \\  reply+=os.read(0,1)
        \\  if reply.endswith(end): return reply.decode()
        \\ raise Exception('unterminated reply')
        \\position=query(b'\x1b[6n',b'R')
        \\pixels=query(b'\x1b[16t',b't')
        \\size=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
        \\os.write(1,(json.dumps([position,pixels,size])+'\r\n').encode())
        \\os.read(0,1)
    ;
    const created = try fixture.request(&.{ "new-session", "--uid", "query", "--cols", "200", "--rows", "4", "--", f.python, "-c", code });
    defer created.deinit();
    const captured = try fixture.wait_text("query", "]]");
    defer captured.deinit();
    const parsed = try std.json.parseFromSlice(std.json.Value, f.allocator, captured.value.text.?, .{});
    defer parsed.deinit();
    const values = parsed.value.array.items;
    try std.testing.expectEqualStrings("\x1b[1;1R", values[0].string);
    const path = try fixture.path("query.png");
    defer f.allocator.free(path);
    const shot = try fixture.exchange(.{ .op = .screenshot, .uid = "query", .path = path });
    defer shot.deinit();
    try expect(shot.value.ok);
    const image = try Image.load(path);
    defer image.deinit();
    const expected = try std.fmt.allocPrint(f.allocator, "\x1b[6;{d};{d}t", .{ image.height / 4, image.width / 200 });
    defer f.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, values[1].string);
    const size = values[2].array.items;
    try std.testing.expectEqual(@as(i64, 4), size[0].integer);
    try std.testing.expectEqual(@as(i64, 200), size[1].integer);
    try std.testing.expectEqual(@as(i64, @intCast(image.width)), size[2].integer);
    try std.testing.expectEqual(@as(i64, @intCast(image.height)), size[3].integer);
}
