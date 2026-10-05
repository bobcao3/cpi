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

pub fn screenshot(io: std.Io, renderer: *render.Renderer, session: *Session, path: []const u8, font_size: u16) !void {
    std.debug.assert(session.allocator.ptr == renderer.allocator.ptr and session.allocator.vtable == renderer.allocator.vtable);
    try options.fontSize(font_size);
    if (path.len == 0 or path.len > 4096 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidPath;
    try renderer.screenshot(io, &session.render_state, &session.terminal, path, font_size);
}

fn execute(allocator: std.mem.Allocator, io: std.Io, renderer: *render.Renderer, session: *Session, request: Request, font_size: u16) !Response {
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
            try screenshot(io, renderer, session, path, request.font_size orelse font_size);
            response.path = path;
        },
        .quit => {},
    }
    return response;
}

pub fn run(allocator: std.mem.Allocator, io: std.Io, input: std.Io.File, session: *Session, font_size: u16) !void {
    var renderer = render.Renderer.init(allocator);
    defer renderer.deinit();
    const buffer = try allocator.alloc(u8, 1024 * 1024 + 1);
    defer allocator.free(buffer);
    var reader = input.readerStreaming(io, buffer);
    var output_buffer: [4096]u8 = undefined;
    var output = std.Io.File.stdout().writerStreaming(io, &output_buffer);
    while (try reader.interface.takeDelimiter('\n')) |line| {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const request_allocator = arena.allocator();
        const request = try std.json.parseFromSliceLeaky(Request, request_allocator, line, .{});
        const response = try execute(request_allocator, io, &renderer, session, request, font_size);
        try std.json.Stringify.value(response, .{ .emit_null_optional_fields = false }, &output.interface);
        try output.interface.writeByte('\n');
        try output.interface.flush();
        if (request.op == .quit) return;
    }
}
