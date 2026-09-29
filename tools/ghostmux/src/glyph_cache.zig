const std = @import("std");
pub const c = @cImport({
    @cInclude("kb_text_shape.h");
    @cInclude("stb_truetype.h");
});
extern fn ghostmux_rasterize(raster: *c.stbtt_fontinfo, pixels: [*]u8, width: c_int, height: c_int, scale_x: f32, scale_y: f32, shift_x: f32, shift_y: f32, glyph: c_int, scratch: [*]u8, scratch_len: usize) c_int;

const Key = struct { face: usize, glyph: c_int, scale_x: u32, scale_y: u32, shift_x: u32, shift_y: u32 };
const Entry = struct { key: Key, pixels: []u8, width: usize, height: usize, left: i32, top: i32 };
const byte_limit = 2 * 1024 * 1024;

pub const Cache = struct {
    entries: [256]?Entry = @splat(null),
    next: usize = 0,
    used: usize = 0,
    scratch: ?[]u8 = null,

    pub fn finish(self: *Cache, allocator: std.mem.Allocator) void {
        if (self.scratch) |scratch| allocator.free(scratch);
        self.scratch = null;
    }

    pub fn deinit(self: *Cache, allocator: std.mem.Allocator) void {
        self.finish(allocator);
        for (&self.entries) |*entry| if (entry.*) |value| {
            allocator.free(value.pixels);
            entry.* = null;
        };
        self.used = 0;
    }

    fn get(self: *Cache, allocator: std.mem.Allocator, raster: *c.stbtt_fontinfo, key: Key) !Entry {
        for (self.entries) |entry| if (entry) |value| {
            if (std.meta.eql(value.key, key)) return value;
        };
        const scale_x: f32 = @bitCast(key.scale_x);
        const scale_y: f32 = @bitCast(key.scale_y);
        const shift_x: f32 = @bitCast(key.shift_x);
        const shift_y: f32 = @bitCast(key.shift_y);
        var left: c_int = 0;
        var top: c_int = 0;
        var right: c_int = 0;
        var bottom: c_int = 0;
        c.stbtt_GetGlyphBitmapBoxSubpixel(raster, key.glyph, scale_x, scale_y, shift_x, shift_y, &left, &top, &right, &bottom);
        const width: usize = @intCast(@max(0, right - left));
        const height: usize = @intCast(@max(0, bottom - top));
        const length = try std.math.mul(usize, width, height);
        if (length > 1024 * 1024) return error.GlyphTooLarge;
        for (0..self.entries.len) |_| {
            if (self.entries[self.next]) |entry| {
                self.used -= entry.pixels.len;
                allocator.free(entry.pixels);
                self.entries[self.next] = null;
            }
            if (self.used + length <= byte_limit) break;
            self.next = (self.next + 1) % self.entries.len;
        }
        std.debug.assert(self.entries[self.next] == null and self.used + length <= byte_limit);
        const pixels = try allocator.alloc(u8, length);
        errdefer allocator.free(pixels);
        if (length > 0) {
            if (self.scratch == null) self.scratch = try allocator.alloc(u8, 4 * 1024 * 1024);
            const scratch = self.scratch.?;
            if (ghostmux_rasterize(raster, pixels.ptr, @intCast(width), @intCast(height), scale_x, scale_y, shift_x, shift_y, key.glyph, scratch.ptr, scratch.len) == 0) return error.GlyphScratchTooLarge;
        }
        const entry: Entry = .{ .key = key, .pixels = pixels, .width = width, .height = height, .left = left, .top = top };
        self.entries[self.next] = entry;
        self.next = (self.next + 1) % self.entries.len;
        self.used += length;
        return entry;
    }

    pub fn draw(self: *Cache, allocator: std.mem.Allocator, raster: *c.stbtt_fontinfo, face: usize, pixels: []u8, image_width: usize, image_height: usize, glyph: c_int, glyph_x: f32, glyph_y: f32, scale_x: f32, scale_y: f32, italic: bool, foreground: [3]u8) !void {
        const origin_x: i32 = @intFromFloat(@floor(glyph_x));
        const origin_y: i32 = @intFromFloat(@floor(glyph_y));
        const bitmap = try self.get(allocator, raster, .{ .face = face, .glyph = glyph, .scale_x = @bitCast(scale_x), .scale_y = @bitCast(scale_y), .shift_x = @bitCast(glyph_x - @as(f32, @floatFromInt(origin_x))), .shift_y = @bitCast(glyph_y - @as(f32, @floatFromInt(origin_y))) });
        for (0..bitmap.height) |gy| {
            const py = @as(i64, origin_y) + bitmap.top + @as(i64, @intCast(gy));
            if (py < 0 or py >= image_height) continue;
            for (0..bitmap.width) |gx| {
                const slant: i64 = if (italic) @intFromFloat(@round((glyph_y - @as(f32, @floatFromInt(py))) * 0.2)) else 0;
                const px = @as(i64, origin_x) + bitmap.left + @as(i64, @intCast(gx)) + slant;
                if (px < 0 or px >= image_width) continue;
                const alpha: u16 = bitmap.pixels[gy * bitmap.width + gx];
                const offset = (@as(usize, @intCast(py)) * image_width + @as(usize, @intCast(px))) * 3;
                for (0..3) |channel| pixels[offset + channel] = @intCast((@as(u16, pixels[offset + channel]) * (255 - alpha) + @as(u16, foreground[channel]) * alpha + 127) / 255);
            }
        }
    }
};
