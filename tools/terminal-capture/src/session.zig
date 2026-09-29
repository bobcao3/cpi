const std = @import("std");
const ghostty = @import("ghostty-vt");
const options = @import("options.zig");
const Self = @This();

allocator: std.mem.Allocator,
terminal: ghostty.Terminal,
stream: ghostty.TerminalStream,

pub fn init(self: *Self, allocator: std.mem.Allocator, io: std.Io, config: options.Options) !void {
    self.allocator = allocator;
    self.terminal = try ghostty.Terminal.init(io, allocator, .{
        .cols = config.cols,
        .rows = config.rows,
        .max_scrollback_bytes = config.scrollback_bytes,
        .default_modes = .{ .grapheme_cluster = true },
        .colors = .{
            .foreground = .init(.{ .r = 255, .g = 255, .b = 255 }),
            .background = .init(.{ .r = 0, .g = 0, .b = 0 }),
            .cursor = .unset,
            .palette = .default,
        },
    });
    self.stream = ghostty.TerminalStream.init(.{
        .allocator = allocator,
        .handler = .{ .terminal = &self.terminal },
        .continuation_max_bytes = 1024 * 1024,
    });
}

pub fn deinit(self: *Self) void {
    self.stream.deinit();
    self.terminal.deinit(self.allocator);
}

pub fn feed(self: *Self, data: []const u8) !void {
    self.stream.nextSlice(data);
    if (self.stream.handler.semantic_failure) return error.TerminalStateFailure;
}

pub fn resize(self: *Self, cols: u16, rows: u16) !void {
    try options.geometry(cols, rows);
    try self.stream.handler.resize(.{ .cols = cols, .rows = rows });
}

pub fn capture(self: *Self, allocator: std.mem.Allocator, history: bool, join: bool) ![]const u8 {
    const pages = &self.terminal.screens.active.pages;
    var formatter = ghostty.formatter.PageListFormatter.init(pages, .{ .emit = .plain, .unwrap = join });
    if (!history) {
        formatter.top_left = pages.getTopLeft(.active);
        formatter.bottom_right = pages.getBottomRight(.active);
    }
    const buffer = try allocator.alloc(u8, 32 * 1024 * 1024);
    defer allocator.free(buffer);
    var writer: std.Io.Writer = .fixed(buffer);
    formatter.format(&writer) catch return error.CaptureTooLarge;
    return allocator.dupe(u8, writer.buffered());
}
