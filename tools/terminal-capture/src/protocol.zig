const std = @import("std");
const Session = @import("session.zig");
const options = @import("options.zig");
const render = @import("render.zig");

const Request = struct {
    op: enum { feed, resize, capture, screenshot, quit },
    data: ?[]const u8 = null,
    base64: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    history: bool = false,
    join: bool = false,
    path: ?[]const u8 = null,
    font_size: ?u16 = null,
};

const Response = struct {
    ok: bool = true,
    text: ?[]const u8 = null,
    path: ?[]const u8 = null,
    cols: u16,
    rows: u16,
};

pub fn screenshot(allocator: std.mem.Allocator, session: *Session, path: []const u8, font_size: u16) !void {
    try options.fontSize(font_size);
    if (path.len == 0 or path.len > 4096 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidPath;
    const terminated = try allocator.dupeZ(u8, path);
    defer allocator.free(terminated);
    try render.screenshot(allocator, &session.terminal, terminated, font_size);
}

fn execute(allocator: std.mem.Allocator, session: *Session, request: Request, font_size: u16) !Response {
    var response: Response = .{ .cols = session.terminal.cols, .rows = session.terminal.rows };
    switch (request.op) {
        .feed => {
            if ((request.data == null) == (request.base64 == null)) return error.ExpectedDataOrBase64;
            if (request.data) |data| {
                try session.feed(data);
            } else if (request.base64) |encoded| {
                const decoder = std.base64.standard.Decoder;
                const decoded = try allocator.alloc(u8, try decoder.calcSizeForSlice(encoded));
                defer allocator.free(decoded);
                try decoder.decode(decoded, encoded);
                try session.feed(decoded);
            }
        },
        .resize => {
            try session.resize(request.cols orelse return error.MissingColumns, request.rows orelse return error.MissingRows);
            response.cols = session.terminal.cols;
            response.rows = session.terminal.rows;
        },
        .capture => response.text = try session.capture(allocator, request.history, request.join),
        .screenshot => {
            const path = request.path orelse return error.MissingPath;
            try screenshot(allocator, session, path, request.font_size orelse font_size);
            response.path = path;
        },
        .quit => {},
    }
    return response;
}

pub fn run(allocator: std.mem.Allocator, io: std.Io, input: std.Io.File, session: *Session, font_size: u16) !void {
    const buffer = try allocator.alloc(u8, 1024 * 1024 + 1);
    defer allocator.free(buffer);
    var reader = input.readerStreaming(io, buffer);
    while (try reader.interface.takeDelimiter('\n')) |line| {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const request_allocator = arena.allocator();
        const parsed = try std.json.parseFromSlice(Request, request_allocator, line, .{ .allocate = .alloc_always });
        defer parsed.deinit();
        const response = try execute(request_allocator, session, parsed.value, font_size);
        const json = try std.json.Stringify.valueAlloc(request_allocator, response, .{ .emit_null_optional_fields = false });
        try std.Io.File.stdout().writeStreamingAll(io, json);
        try std.Io.File.stdout().writeStreamingAll(io, "\n");
        if (parsed.value.op == .quit) return;
    }
}
