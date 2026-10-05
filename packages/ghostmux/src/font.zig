const std = @import("std");
const c = glyph_cache.c;

const fonts = @import("fonts");
const glyph_cache = @import("glyph_cache.zig");
const font_bytes = blk: {
    var result: [fonts.data.values.len][]const u8 = undefined;
    for (fonts.data.values, 0..) |bytes, i| {
        const Storage = struct {
            const data align(16) = bytes[0..bytes.len].*;
        };
        result[i] = &Storage.data;
    }
    break :blk result;
};
pub const max_run_cells: usize = 32;
pub const max_run_points: usize = 128;
pub const Input = struct { point: u21, cell: u8 };
const Face = struct { shape: c.kbts_font, raster: c.stbtt_fontinfo };
pub const Metrics = struct { width: usize, height: usize, baseline: f32, size: f32, ideograph_width: f32 };
pub const Engine = struct {
    faces: [font_bytes.len]Face = undefined,
    cache: glyph_cache.Cache = .{},
    context: *c.kbts_shape_context,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) !Engine {
        var self: Engine = .{ .context = c.kbts_CreateShapeContext(null, null) orelse return error.ShapeContextInitFailed, .allocator = allocator };
        errdefer c.kbts_DestroyShapeContext(self.context);
        var count: usize = 0;
        errdefer {
            for (self.faces[0..count]) |*face| {
                c.kbts_FreeFont(&face.shape);
            }
        }
        for (font_bytes, 0..) |bytes, i| {
            if (bytes.len > std.math.maxInt(c_int)) return error.FontTooLarge;
            self.faces[i].shape = c.kbts_FontFromMemory(@constCast(bytes.ptr), @intCast(bytes.len), 0, null, null);
            if (self.faces[i].shape.Error != c.KBTS_LOAD_FONT_ERROR_NONE) {
                c.kbts_FreeFont(&self.faces[i].shape);
                return error.InvalidFont;
            }
            count += 1;
            const offset = c.stbtt_GetFontOffsetForIndex(bytes.ptr, 0);
            self.faces[i].raster = std.mem.zeroes(c.stbtt_fontinfo);
            if (offset < 0 or c.stbtt_InitFont(&self.faces[i].raster, bytes.ptr, offset) == 0) return error.InvalidFont;
        }
        return self;
    }

    pub fn deinit(self: *Engine) void {
        self.cache.deinit(self.allocator);
        for (&self.faces) |*face| {
            c.kbts_FreeFont(&face.shape);
        }
        c.kbts_DestroyShapeContext(self.context);
    }

    pub fn finish(self: *Engine) void {
        self.cache.finish(self.allocator);
    }

    pub fn metrics(self: *Engine, size: u16) !Metrics {
        return raster_metrics(&self.faces[0].raster, size);
    }

    pub fn choose(self: *Engine, points: []const u21, bold: bool) usize {
        const preferred: fonts.Face = if (bold) .mono_bold else .mono;
        const order = [_]fonts.Face{ preferred, .emoji, .icons, if (bold) .cjk_bold else .cjk, if (bold) .mono else .mono_bold };
        for (order) |face| {
            const i = @intFromEnum(face);
            var found = true;
            for (points) |cp| {
                if (cp == 0xfe0e or cp == 0xfe0f or cp == 0x200d) continue;
                if (c.stbtt_FindGlyphIndex(&self.faces[i].raster, cp) == 0) {
                    found = false;
                    break;
                }
            }
            if (found) return i;
        }
        return @intFromEnum(preferred);
    }

    pub fn draw(self: *Engine, pixels: []u8, image_width: usize, image_height: usize, x: usize, y: usize, cells: usize, input: []const Input, face_index: usize, italic: bool, metrics_value: Metrics, foreground: [3]u8) !void {
        if (input.len == 0 or input.len > max_run_points or cells == 0 or cells > max_run_cells or face_index >= self.faces.len) return error.InvalidRun;
        const face = &self.faces[face_index];
        if (c.kbts_ShapePushFont(self.context, &face.shape) == null) return error.ShapeFontPushFailed;
        defer _ = c.kbts_ShapePopFont(self.context);
        c.kbts_ShapeBegin(self.context, c.KBTS_DIRECTION_LTR, c.KBTS_LANGUAGE_DONT_KNOW);
        for (input) |item| {
            if (item.cell >= cells) return error.InvalidRun;
            c.kbts_ShapeCodepointWithUserId(self.context, item.point, item.cell);
        }
        c.kbts_ShapeEnd(self.context);
        if (c.kbts_ShapeError(self.context) != c.KBTS_SHAPE_ERROR_NONE) return error.ShapeFailed;
        const raster = &face.raster;
        const face_kind: fonts.Face = @enumFromInt(face_index);
        const scale_y = switch (face_kind) {
            .cjk, .cjk_bold => metrics_value.ideograph_width / @as(f32, @floatFromInt(ideographAdvance(raster) orelse return error.InvalidFont)),
            else => c.stbtt_ScaleForMappingEmToPixels(raster, metrics_value.size),
        };
        var ascent: c_int = 0;
        var descent: c_int = 0;
        var gap: c_int = 0;
        c.stbtt_GetFontVMetrics(raster, &ascent, &descent, &gap);
        const Placed = struct { id: c_int, point: c_int, cell: usize, advance: i32, offset_x: i32, offset_y: i32 };
        var placed: [max_run_points * 4]Placed = undefined;
        var count: usize = 0;
        var run: c.kbts_run = undefined;
        while (c.kbts_ShapeRun(self.context, &run) != 0) {
            var glyph: ?*c.kbts_glyph = null;
            while (c.kbts_GlyphIteratorNext(&run.Glyphs, &glyph) != 0) {
                const item = glyph orelse return error.InvalidGlyph;
                if (count == placed.len) return error.TooManyGlyphs;
                var source: c.kbts_shape_codepoint = undefined;
                if (c.kbts_ShapeGetShapeCodepoint(self.context, item.UserIdOrCodepointIndex, &source) == 0) return error.InvalidGlyph;
                if (source.UserId < 0 or source.UserId >= cells) return error.InvalidGlyph;
                placed[count] = .{ .id = item.Id, .point = source.Codepoint, .cell = @intCast(source.UserId), .advance = item.AdvanceX, .offset_x = item.OffsetX, .offset_y = item.OffsetY };
                count += 1;
            }
        }
        var i: usize = 0;
        while (i < count) {
            const start = placed[i].cell;
            var end = i + 1;
            while (end < count and placed[end].cell == start) : (end += 1) {}
            var next = cells;
            for (placed[0..count]) |other| {
                if (other.cell > start) next = @min(next, other.cell);
            }
            var advance: i64 = 0;
            for (placed[i..end]) |item| advance += item.advance;
            const span_width: f32 = @floatFromInt((next - start) * metrics_value.width);
            const scale = if (advance > 0) @min(scale_y, span_width / @as(f32, @floatFromInt(advance))) else scale_y;
            const padding = @max(0, (span_width - @as(f32, @floatFromInt(advance)) * scale) * 0.5);
            const baseline = @as(f32, @floatFromInt(y)) + (@as(f32, @floatFromInt(metrics_value.height)) - @as(f32, @floatFromInt(ascent - descent)) * scale) * 0.5 + @as(f32, @floatFromInt(ascent)) * scale;
            var pen: i64 = 0;
            for (placed[i..end]) |item| {
                var glyph_x = @as(f32, @floatFromInt(x + start * metrics_value.width)) + padding + @as(f32, @floatFromInt(pen + item.offset_x)) * scale;
                var glyph_y = baseline - @as(f32, @floatFromInt(item.offset_y)) * scale;
                var glyph_scale_x = scale;
                var glyph_scale_y = scale;
                if (item.point >= 0x2500 and item.point <= 0x259f and advance > 0) {
                    var x0: c_int = 0;
                    var y0: c_int = 0;
                    var x1: c_int = 0;
                    var y1: c_int = 0;
                    if (c.stbtt_GetCodepointBox(raster, '│', &x0, &y0, &x1, &y1) != 0 and y1 > y0) {
                        glyph_scale_x = span_width / @as(f32, @floatFromInt(advance));
                        glyph_scale_y = @as(f32, @floatFromInt(metrics_value.height)) / @as(f32, @floatFromInt(y1 - y0));
                        glyph_x = @as(f32, @floatFromInt(x + start * metrics_value.width)) + @as(f32, @floatFromInt(pen + item.offset_x)) * glyph_scale_x;
                        glyph_y = @as(f32, @floatFromInt(y)) + @as(f32, @floatFromInt(y1 - item.offset_y)) * glyph_scale_y;
                    }
                }
                if (!std.math.isFinite(glyph_x) or !std.math.isFinite(glyph_y) or @abs(glyph_x) > 1000000 or @abs(glyph_y) > 1000000) return error.InvalidGlyph;
                try self.cache.draw(self.allocator, raster, face_index, pixels, image_width, image_height, item.id, glyph_x, glyph_y, glyph_scale_x, glyph_scale_y, italic, foreground);
                pen += item.advance;
            }
            i = end;
        }
    }
};

pub fn metrics(size: u16) !Metrics {
    const bytes = font_bytes[@intFromEnum(fonts.Face.mono)];
    var face: c.stbtt_fontinfo = std.mem.zeroes(c.stbtt_fontinfo);
    const offset = c.stbtt_GetFontOffsetForIndex(bytes.ptr, 0);
    if (offset < 0 or c.stbtt_InitFont(&face, bytes.ptr, offset) == 0) return error.InvalidFont;
    return raster_metrics(&face, size);
}

fn raster_metrics(face: *c.stbtt_fontinfo, size: u16) !Metrics {
    if (size < 6 or size > 128) return error.InvalidFontSize;
    const requested_scale = c.stbtt_ScaleForMappingEmToPixels(face, @floatFromInt(size));
    var advance: c_int = 0;
    var bearing: c_int = 0;
    c.stbtt_GetCodepointHMetrics(face, 'M', &advance, &bearing);
    if (advance <= 0) return error.InvalidFont;
    const width = @ceil(@as(f32, @floatFromInt(advance)) * requested_scale);
    const scale = width / @as(f32, @floatFromInt(advance));
    var ascent: c_int = 0;
    var descent: c_int = 0;
    var gap: c_int = 0;
    c.stbtt_GetFontVMetrics(face, &ascent, &descent, &gap);
    return .{
        .width = @max(1, @as(usize, @intFromFloat(width))),
        .height = @max(1, @as(usize, @intFromFloat(@ceil(@as(f32, @floatFromInt(ascent - descent + gap)) * scale)))),
        .baseline = @as(f32, @floatFromInt(ascent)) * scale,
        .size = @as(f32, @floatFromInt(size)) * scale / requested_scale,
        .ideograph_width = if (ideographAdvance(face)) |ic| @as(f32, @floatFromInt(ic)) * scale else @min(asciiHeight(face) * scale, 2 * width),
    };
}

fn ideographAdvance(face: *c.stbtt_fontinfo) ?c_int {
    if (c.stbtt_FindGlyphIndex(face, '水') == 0) return null;
    var advance: c_int = 0;
    var bearing: c_int = 0;
    var x0: c_int = 0;
    var y0: c_int = 0;
    var x1: c_int = 0;
    var y1: c_int = 0;
    c.stbtt_GetCodepointHMetrics(face, '水', &advance, &bearing);
    if (c.stbtt_GetCodepointBox(face, '水', &x0, &y0, &x1, &y1) == 0 or advance <= 0 or x1 - x0 > advance) return null;
    return advance;
}

fn asciiHeight(face: *c.stbtt_fontinfo) f32 {
    var top: c_int = 0;
    var bottom: c_int = 0;
    for (32..127) |point| {
        var x0: c_int = 0;
        var y0: c_int = 0;
        var x1: c_int = 0;
        var y1: c_int = 0;
        if (c.stbtt_GetCodepointBox(face, @intCast(point), &x0, &y0, &x1, &y1) == 0) continue;
        top = @max(top, y1);
        bottom = @min(bottom, y0);
    }
    std.debug.assert(top > bottom);
    return @floatFromInt(top - bottom);
}
