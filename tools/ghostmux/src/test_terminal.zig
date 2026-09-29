const std = @import("std");
const f = @import("test_fixture.zig");
const Session = @import("session.zig");
const Image = @import("test_image.zig").Image;
const expect = std.testing.expect;

fn capture(session: *Session, history: bool, join: bool, text: []const u8) !void {
    const actual = try session.capture(f.allocator, history, join);
    defer f.allocator.free(actual);
    try std.testing.expectEqualStrings(text, actual);
}

test "VT edits, Unicode graphemes and soft wrapping" {
    var session: Session = undefined;
    try session.init(f.allocator, f.io, .{ .cols = 20, .rows = 4 });
    defer session.deinit();
    try session.feed("old status\r\x1b[2Kdone\r\n中文 😀 é\r\n");
    try capture(&session, false, false, "done\n中文 😀 é");
    try session.resize(5, 6);
    try session.feed("\x1b[2J\x1b[Habcdefghijk\r\nend");
    try capture(&session, false, false, "abcde\nfghij\nk\nend");
    try capture(&session, false, true, "abcdefghijk\nend");
}

test "fragmented VT parser, alternate screen, history and resize" {
    var session: Session = undefined;
    try session.init(f.allocator, f.io, .{ .cols = 8, .rows = 3 });
    defer session.deinit();
    const data = "\x1b]2;split title\x1b\\\x1bP$qm\x1b\\\x1b[31m中é\x1b[0m";
    for (data) |byte| try session.feed(&.{byte});
    try capture(&session, false, false, "中é");
    try session.feed("\x1b[?1049h\x1b[2J\x1b[Halternate");
    try capture(&session, false, true, "alternate");
    try session.feed("\x1b[?1049l");
    try capture(&session, false, false, "中é");
    try session.feed("\r\nline2\r\nline3\r\nline4");
    try capture(&session, false, false, "line2\nline3\nline4");
    try capture(&session, true, false, "中é\nline2\nline3\nline4");
    try session.resize(12, 5);
    try capture(&session, true, false, "中é\nline2\nline3\nline4");
}

test "PNG screenshots render embedded fallback fonts, colors, overhang and changed state" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const path = try fixture.path("screen.png");
    defer f.allocator.free(path);
    var session: Session = undefined;
    try session.init(f.allocator, f.io, .{ .cols = 24, .rows = 6 });
    defer session.deinit();
    var renderer = @import("render.zig").Renderer.init(f.allocator);
    defer renderer.deinit();
    try session.feed("\x1b[?25l\x1b]11;#102030\x1b\\\x1b[38;2;240;80;20m\x1b[48;2;7;11;17mA\x1b[0m\r\n中文 日本 한글\r\n😀 🚀 ❤️\r\n\u{f120} \u{f09b} \u{e0b0}\r\né ≠ ┌─┐\x1b[5;11H\x1b[3mW\x1b[0m\r\n口");
    for (0..6) |y| {
        var buffer: [32]u8 = undefined;
        try session.feed(try std.fmt.bufPrint(&buffer, "\x1b[{d};24H│", .{y + 1}));
    }
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 16);
    const first = try Image.load(path);
    defer first.deinit();
    try expect(first.width % 24 == 0 and first.height % 6 == 0);
    const cw = first.width / 24;
    const ch = first.height / 6;
    const background = &[_]u8{ 16, 32, 48 };
    try std.testing.expectEqualSlices(u8, &.{ 7, 11, 17 }, first.pixel(0, 0));
    try std.testing.expectEqualSlices(u8, background, first.pixel(first.width - 1, first.height - 1));
    for (0..first.height) |y| try expect(!std.mem.eql(u8, background, first.pixel(23 * cw + cw / 2, y)));
    for ([_][3]usize{ .{ 0, 0, 1 }, .{ 1, 0, 1 }, .{ 1, 1, 1 }, .{ 1, 5, 2 }, .{ 1, 10, 2 }, .{ 2, 0, 2 }, .{ 2, 3, 2 }, .{ 3, 0, 1 }, .{ 3, 2, 1 }, .{ 3, 4, 1 }, .{ 4, 0, 1 } }) |cell| {
        var colors: std.AutoHashMap(u32, void) = .init(f.allocator);
        defer colors.deinit();
        for (cell[0] * ch..(cell[0] + 1) * ch) |y| {
            for (cell[1] * cw..(cell[1] + cell[2]) * cw) |x| {
                const p = first.pixel(x, y);
                try colors.put(@as(u32, p[0]) << 16 | @as(u32, p[1]) << 8 | p[2], {});
            }
        }
        try expect(colors.count() > 2);
    }
    var overhang = false;
    for (4 * ch..5 * ch) |y| {
        for (11 * cw..12 * cw) |x| overhang = overhang or !std.mem.eql(u8, background, first.pixel(x, y));
    }
    try expect(overhang);
    var left: usize = first.width;
    var right: usize = 0;
    var top: usize = first.height;
    var bottom: usize = 0;
    for (5 * ch..6 * ch) |y| {
        for (0..2 * cw) |x| {
            if (std.mem.eql(u8, background, first.pixel(x, y))) continue;
            left = @min(left, x);
            right = @max(right, x);
            top = @min(top, y);
            bottom = @max(bottom, y);
        }
    }
    const aspect = @as(f64, @floatFromInt(right - left + 1)) / @as(f64, @floatFromInt(bottom - top + 1));
    try expect(aspect >= 0.8 and aspect <= 1.15);
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 16);
    const repeated = try Image.load(path);
    defer repeated.deinit();
    try std.testing.expectEqualSlices(u8, first.pixels, repeated.pixels);
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 31);
    const larger = try Image.load(path);
    defer larger.deinit();
    try expect(larger.width != first.width);
    try session.feed("\x1b[?1049h\x1b[2J\x1b[Halternate");
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 16);
    const alternate = try Image.load(path);
    defer alternate.deinit();
    try expect(!std.mem.eql(u8, first.pixels, alternate.pixels));
    try session.feed("\x1b[?1049l");
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 16);
    const restored = try Image.load(path);
    defer restored.deinit();
    try std.testing.expectEqualSlices(u8, first.pixels, restored.pixels);
    try session.feed("\x1b[2J\x1b[Hnew frame");
    try session.resize(12, 7);
    try @import("protocol.zig").screenshot(f.io, &renderer, &session, path, 16);
    const resized = try Image.load(path);
    defer resized.deinit();
    try std.testing.expectEqual(12 * cw, resized.width);
    try std.testing.expectEqual(7 * ch, resized.height);
    try capture(&session, false, false, "new frame");
}

test "raw CLI and malformed protocol reject invalid records without hanging" {
    var fixture = try f.Fixture.init();
    defer fixture.deinit();
    const input_path = try fixture.path("input");
    defer f.allocator.free(input_path);
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = input_path, .data = "old\r\x1b[2K中文 😀 é\n" });
    const raw = try f.run(&.{ f.binary, "--input", input_path });
    defer f.free_result(raw);
    try f.success(raw);
    try std.testing.expectEqualStrings("中文 😀 é\n", raw.stdout);
    for ([_]struct { input: []const u8, name: []const u8 }{
        .{ .input = "{\"op\":\"feed\",\"data\":\"a\",\"base64\":\"Yg==\"}\n", .name = "ExpectedDataOrBase64" },
        .{ .input = "{\"op\":\"resize\",\"cols\":501,\"rows\":2}\n", .name = "InvalidGeometry" },
        .{ .input = "{\"op\":\"feed\",\"base64\":\"?\"}\n", .name = "Invalid" },
    }) |case| {
        try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = input_path, .data = case.input });
        const result = try f.run(&.{ f.binary, "--protocol", "--input", input_path });
        defer f.free_result(result);
        try expect(result.term == .exited and result.term.exited == 1);
        try expect(std.mem.indexOf(u8, result.stderr, case.name) != null);
    }
    const oversized = try f.allocator.alloc(u8, 1024 * 1024 + 2);
    defer f.allocator.free(oversized);
    @memset(oversized, 'x');
    try std.Io.Dir.cwd().writeFile(f.io, .{ .sub_path = input_path, .data = oversized });
    const result = try f.run(&.{ f.binary, "--protocol", "--input", input_path });
    defer f.free_result(result);
    try expect(result.term == .exited and result.term.exited == 1);
    try expect(std.mem.indexOf(u8, result.stderr, "StreamTooLong") != null);
}
