//! tree-sitter-wasm — Self-contained WASM module that parses shell commands
//! using tree-sitter + tree-sitter-bash, compiled with Zig.
//!
//! Exports:
//!   alloc(size) -> ptr          — allocate memory (for source string input)
//!   dealloc(ptr)                — free memory
//!   parse(ptr, len) -> ptr      — parse source, return JSON AST pointer
//!   result_len() -> u32         — length of last parse result

const std = @import("std");
const Writer = std.Io.Writer;

const c = @cImport({
    @cInclude("tree_sitter/api.h");
});

extern fn tree_sitter_bash() ?*const c.TSLanguage;

const TSNode = c.TSNode;

var result_buf: [256 * 1024]u8 = undefined;
var result_len_val: u32 = 0;

export fn alloc(size: u32) ?[*]u8 {
    return @ptrCast(std.c.malloc(size));
}

export fn dealloc(ptr: ?[*]u8) void {
    if (ptr) |p| std.c.free(@ptrCast(p));
}

export fn parse(source_ptr: [*]const u8, source_len: u32) ?[*]const u8 {
    const source = source_ptr[0..source_len];

    const parser = c.ts_parser_new() orelse return null;
    defer c.ts_parser_delete(parser);

    if (!c.ts_parser_set_language(parser, tree_sitter_bash())) return null;

    const tree = c.ts_parser_parse_string(parser, null, source.ptr, source_len) orelse return null;
    defer c.ts_tree_delete(tree);

    const root = c.ts_tree_root_node(tree);

    var w: Writer = .fixed(&result_buf);
    serializeNode(&w, root, source, null) catch {
        result_len_val = 0;
        return null;
    };
    result_len_val = @intCast(w.buffered().len);

    return &result_buf;
}

export fn result_len() u32 {
    return result_len_val;
}

fn jsonEscape(w: *Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |ch| {
        switch (ch) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            else => {
                if (ch < 0x20) {
                    try w.print("\\u{x:0>4}", .{ch});
                } else {
                    try w.writeByte(ch);
                }
            },
        }
    }
    try w.writeByte('"');
}

fn serializeNode(w: *Writer, node: TSNode, source: []const u8, field_name: ?[]const u8) !void {
    const node_type = c.ts_node_type(node);
    const type_str = std.mem.span(node_type);
    const is_named = c.ts_node_is_named(node);
    const start = c.ts_node_start_point(node);
    const end = c.ts_node_end_point(node);
    const start_byte = c.ts_node_start_byte(node);
    const end_byte = c.ts_node_end_byte(node);
    const text = source[start_byte..end_byte];

    try w.writeAll("{\"type\":");
    try jsonEscape(w, type_str);
    try w.print(",\"isNamed\":{}", .{is_named});

    if (field_name) |fname| {
        try w.writeAll(",\"fieldName\":");
        try jsonEscape(w, fname);
    } else {
        try w.writeAll(",\"fieldName\":null");
    }

    try w.print(",\"startRow\":{d},\"startCol\":{d},\"endRow\":{d},\"endCol\":{d}", .{
        start.row, start.column, end.row, end.column,
    });

    try w.writeAll(",\"text\":");
    try jsonEscape(w, text);

    const child_count = c.ts_node_child_count(node);
    if (child_count > 0) {
        try w.writeAll(",\"children\":[");
        var i: u32 = 0;
        while (i < child_count) : (i += 1) {
            if (i > 0) try w.writeByte(',');
            const child = c.ts_node_child(node, i);
            const fname_c = c.ts_node_field_name_for_child(node, i);
            const fname = if (fname_c != null) std.mem.span(fname_c) else null;
            try serializeNode(w, child, source, fname);
        }
        try w.writeByte(']');
    }

    try w.writeByte('}');
}
