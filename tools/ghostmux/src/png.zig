const std = @import("std");
const Writer = std.Io.Writer;
const flate = std.compress.flate;

const Workspace = struct {
    compressor: flate.Compress,
    window: [flate.max_window_len]u8,
    idat: [32768]u8,
    row: [8192 * 3]u8,
    candidate: [8192 * 3]u8,
};

pub fn write(allocator: std.mem.Allocator, io: std.Io, path: []const u8, width: usize, height: usize, pixels: []const u8) !void {
    std.debug.assert(width > 0 and width <= 8192 and height > 0 and height <= 8192);
    std.debug.assert(pixels.len == width * height * 3);
    const workspace = try allocator.create(Workspace);
    defer allocator.destroy(workspace);
    const file = std.Io.Dir.cwd().createFile(io, path, .{}) catch return error.PngWriteFailed;
    defer file.close(io);
    var file_buffer: [8192]u8 = undefined;
    var output = file.writerStreaming(io, &file_buffer);
    encode(&output.interface, workspace, width, height, pixels) catch return error.PngWriteFailed;
    output.interface.flush() catch return error.PngWriteFailed;
}

fn encode(output: *Writer, workspace: *Workspace, width: usize, height: usize, pixels: []const u8) !void {
    try output.writeAll(&.{ 137, 80, 78, 71, 13, 10, 26, 10 });
    var header: [13]u8 = undefined;
    std.mem.writeInt(u32, header[0..4], @intCast(width), .big);
    std.mem.writeInt(u32, header[4..8], @intCast(height), .big);
    header[8..13].* = .{ 8, 2, 0, 0, 0 };
    try chunk(output, "IHDR", &header);

    var idat = Idat{
        .output = output,
        .writer = .{ .buffer = &workspace.idat, .vtable = &.{ .drain = Idat.drain } },
    };
    workspace.compressor = try flate.Compress.init(&idat.writer, &workspace.window, .zlib, .fastest);
    const row_bytes = width * 3;
    for (0..height) |y| {
        const current = pixels[y * row_bytes ..][0..row_bytes];
        const previous = if (y == 0) &.{} else pixels[(y - 1) * row_bytes ..][0..row_bytes];
        var best_score: u32 = std.math.maxInt(u32);
        var best_kind: u8 = 0;
        for (0..5) |kind| {
            const score = filter(current, previous, @intCast(kind), workspace.candidate[0..row_bytes]);
            if (score < best_score) {
                best_score = score;
                best_kind = @intCast(kind);
                std.mem.copyForwards(u8, workspace.row[0..row_bytes], workspace.candidate[0..row_bytes]);
            }
        }
        try workspace.compressor.writer.writeByte(best_kind);
        try workspace.compressor.writer.writeAll(workspace.row[0..row_bytes]);
    }
    try workspace.compressor.finish();
    try idat.writer.flush();
    try chunk(output, "IEND", &.{});
}

const Idat = struct {
    output: *Writer,
    writer: Writer,

    fn drain(writer: *Writer, data: []const []const u8, splat: usize) Writer.Error!usize {
        const self: *Idat = @fieldParentPtr("writer", writer);
        if (writer.end > 0) {
            try chunk(self.output, "IDAT", writer.buffered());
            writer.end = 0;
        }
        if (data.len == 1 and splat == 0) return 0;
        const n = @min(data[0].len, writer.buffer.len);
        std.mem.copyForwards(u8, writer.buffer[0..n], data[0][0..n]);
        writer.end = n;
        return n;
    }
};

fn chunk(output: *Writer, kind: *const [4]u8, data: []const u8) !void {
    var integer: [4]u8 = undefined;
    std.mem.writeInt(u32, &integer, @intCast(data.len), .big);
    try output.writeAll(&integer);
    try output.writeAll(kind);
    try output.writeAll(data);
    var crc: std.hash.Crc32 = .init();
    crc.update(kind);
    crc.update(data);
    std.mem.writeInt(u32, &integer, crc.final(), .big);
    try output.writeAll(&integer);
}

fn filter(current: []const u8, previous: []const u8, kind: u8, result: []u8) u32 {
    var score: u32 = 0;
    for (current, 0..) |value, i| {
        const left = if (i >= 3) current[i - 3] else 0;
        const above = if (previous.len > 0) previous[i] else 0;
        const upper_left = if (i >= 3 and previous.len > 0) previous[i - 3] else 0;
        const predictor: u8 = switch (kind) {
            0 => 0,
            1 => left,
            2 => above,
            3 => @intCast((@as(u16, left) + above) / 2),
            4 => paeth(left, above, upper_left),
            else => unreachable,
        };
        const filtered = value -% predictor;
        result[i] = filtered;
        score += @as(u32, @intCast(@abs(@as(i16, @as(i8, @bitCast(filtered))))));
    }
    return score;
}

fn paeth(left: u8, above: u8, upper_left: u8) u8 {
    const a: i16 = left;
    const b: i16 = above;
    const c: i16 = upper_left;
    const p = a + b - c;
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    return if (pa <= pb and pa <= pc) left else if (pb <= pc) above else upper_left;
}
