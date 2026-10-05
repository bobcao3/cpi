const std = @import("std");
const f = @import("test_fixture.zig");

pub const Image = struct {
    width: usize,
    height: usize,
    pixels: []u8,

    pub fn deinit(self: Image) void {
        f.allocator.free(self.pixels);
    }

    pub fn pixel(self: Image, x: usize, y: usize) []const u8 {
        return self.pixels[(y * self.width + x) * 3 ..][0..3];
    }

    pub fn load(path: []const u8) !Image {
        const bytes = try std.Io.Dir.cwd().readFileAlloc(f.io, path, f.allocator, .limited(16 * 1024 * 1024));
        defer f.allocator.free(bytes);
        try std.testing.expectEqualSlices(u8, &.{ 137, 80, 78, 71, 13, 10, 26, 10 }, bytes[0..8]);
        var compressed: std.ArrayList(u8) = .empty;
        defer compressed.deinit(f.allocator);
        var width: usize = 0;
        var height: usize = 0;
        var offset: usize = 8;
        var ended = false;
        while (offset + 12 <= bytes.len) {
            const length = std.mem.readInt(u32, bytes[offset..][0..4], .big);
            try std.testing.expect(length <= bytes.len - offset - 12);
            const kind = bytes[offset + 4 ..][0..4];
            const data = bytes[offset + 8 ..][0..length];
            var crc: std.hash.Crc32 = .init();
            crc.update(kind);
            crc.update(data);
            try std.testing.expectEqual(crc.final(), std.mem.readInt(u32, bytes[offset + 8 + length ..][0..4], .big));
            if (std.mem.eql(u8, kind, "IHDR")) {
                try std.testing.expectEqual(@as(usize, 13), data.len);
                width = std.mem.readInt(u32, data[0..4], .big);
                height = std.mem.readInt(u32, data[4..8], .big);
                try std.testing.expectEqualSlices(u8, &.{ 8, 2, 0, 0, 0 }, data[8..13]);
            } else if (std.mem.eql(u8, kind, "IDAT")) {
                try compressed.appendSlice(f.allocator, data);
            } else if (std.mem.eql(u8, kind, "IEND")) ended = true;
            offset += length + 12;
        }
        try std.testing.expect(ended and offset == bytes.len and width > 0 and height > 0 and width <= 8192 and height <= 8192);
        const stride = width * 3;
        const raw = try f.allocator.alloc(u8, (stride + 1) * height);
        defer f.allocator.free(raw);
        var input = std.Io.Reader.fixed(compressed.items);
        var window: [std.compress.flate.max_window_len]u8 = undefined;
        var decompressor = std.compress.flate.Decompress.init(&input, .zlib, &window);
        try decompressor.reader.readSliceAll(raw);
        const pixels = try f.allocator.alloc(u8, stride * height);
        errdefer f.allocator.free(pixels);
        for (0..height) |y| {
            const row = raw[y * (stride + 1) ..][0 .. stride + 1];
            try std.testing.expect(row[0] <= 4);
            for (row[1..], 0..) |value, x| {
                const left = if (x >= 3) pixels[y * stride + x - 3] else 0;
                const above = if (y > 0) pixels[(y - 1) * stride + x] else 0;
                const corner = if (y > 0 and x >= 3) pixels[(y - 1) * stride + x - 3] else 0;
                const prediction: u8 = switch (row[0]) {
                    0 => 0,
                    1 => left,
                    2 => above,
                    3 => @intCast((@as(u16, left) + above) / 2),
                    4 => blk: {
                        const p = @as(i32, left) + above - corner;
                        const distances = [3]u32{ @intCast(@abs(p - left)), @intCast(@abs(p - above)), @intCast(@abs(p - corner)) };
                        break :blk if (distances[0] <= distances[1] and distances[0] <= distances[2]) left else if (distances[1] <= distances[2]) above else corner;
                    },
                    else => unreachable,
                };
                pixels[y * stride + x] = value +% prediction;
            }
        }
        return .{ .width = width, .height = height, .pixels = pixels };
    }
};
