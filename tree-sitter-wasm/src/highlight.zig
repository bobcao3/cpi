//! Highlight query execution.
//!
//! Compiles each language's embedded `highlights.scm` (vendored from
//! neovim-treesitter-queries via `zig fetch`) once, runs it over a parsed
//! source, evaluates the `#eq?` / `#any-of?` / `#lua-match?` predicates the C
//! library leaves to the consumer, and emits capture byte-ranges as JSON:
//!   [{"s":<u32>,"e":<u32>,"c":"<capture>"},...]
//!
//! Non-visual captures (`@none`/`@spell`/`@nospell`) are disabled at the query
//! level; auxiliary captures whose name starts with `_` are dropped on emit.

const std = @import("std");
const Writer = std.Io.Writer;
const c = @import("c");
const lua_match = @import("lua_match.zig");
const languages = @import("languages.zig");

const MAX_SOURCE: usize = 65536; // bound work for pathological long sources
const MAX_OPERANDS: usize = 32;
const LANG_COUNT = languages.LANGS.len;

var queries: [LANG_COUNT]?*c.TSQuery = [_]?*c.TSQuery{null} ** LANG_COUNT;
var attempted: [LANG_COUNT]bool = [_]bool{false} ** LANG_COUNT;
var ok: [LANG_COUNT]bool = [_]bool{false} ** LANG_COUNT;

pub fn run(lang_index: usize, source: []const u8, w: *Writer) !void {
    try w.writeByte('[');
    if (source.len > MAX_SOURCE or lang_index >= LANG_COUNT) {
        try w.writeByte(']');
        return;
    }
    if (!ensureQuery(lang_index)) {
        try w.writeByte(']');
        return;
    }
    const q = queries[lang_index].?;
    const lang = languages.LANGS[lang_index].lang() orelse {
        try w.writeByte(']');
        return;
    };

    const parser = c.ts_parser_new() orelse {
        try w.writeByte(']');
        return;
    };
    defer c.ts_parser_delete(parser);
    if (!c.ts_parser_set_language(parser, lang)) {
        try w.writeByte(']');
        return;
    }
    const tree = c.ts_parser_parse_string(parser, null, source.ptr, @intCast(source.len)) orelse {
        try w.writeByte(']');
        return;
    };
    defer c.ts_tree_delete(tree);
    const root = c.ts_tree_root_node(tree);

    const cursor = c.ts_query_cursor_new() orelse {
        try w.writeByte(']');
        return;
    };
    defer c.ts_query_cursor_delete(cursor);
    c.ts_query_cursor_exec(cursor, q, root);

    var first = true;
    var m: c.TSQueryMatch = undefined;
    while (c.ts_query_cursor_next_match(cursor, &m)) {
        if (!predicatesPass(q, &m, source)) continue;
        var i: usize = 0;
        while (i < m.capture_count) : (i += 1) {
            const cap = m.captures[i];
            var nlen: u32 = 0;
            const nptr = c.ts_query_capture_name_for_id(q, cap.index, &nlen);
            const name: []const u8 = if (nptr == null) &.{} else nptr[0..nlen];
            if (name.len != 0 and name[0] == '_') continue; // auxiliary capture
            const sb: usize = @intCast(c.ts_node_start_byte(cap.node));
            const eb: usize = @intCast(c.ts_node_end_byte(cap.node));
            if (sb > source.len or eb > source.len or eb < sb) continue;
            if (!first) try w.writeByte(',');
            first = false;
            try w.print("{{\"s\":{d},\"e\":{d},\"c\":\"{s}\"}}", .{ sb, eb, name });
        }
    }
    try w.writeByte(']');
}

fn ensureQuery(idx: usize) bool {
    if (attempted[idx]) return ok[idx];
    attempted[idx] = true;
    const lang = languages.LANGS[idx].lang() orelse return false;
    const scm = languages.LANGS[idx].query;
    var err_off: u32 = 0;
    var err_type: c.TSQueryError = c.TSQueryErrorNone;
    const q = c.ts_query_new(lang, scm.ptr, @intCast(scm.len), &err_off, &err_type);
    if (q == null) return false; // node-type / field / syntax mismatch vs grammar
    const qp: *c.TSQuery = q.?;
    queries[idx] = qp;
    ok[idx] = true;
    disableCapture(qp, "none");
    disableCapture(qp, "spell");
    disableCapture(qp, "nospell");
    return true;
}

fn disableCapture(q: *c.TSQuery, name: []const u8) void {
    c.ts_query_disable_capture(q, name.ptr, name.len);
}

const Operand = struct { is_str: bool, str: []const u8, cap_id: u32 };

/// True iff every predicate group for `m`'s pattern passes. The C library does
/// not evaluate predicates; it only reports their step structure, so we do it.
fn predicatesPass(q: *c.TSQuery, m: *c.TSQueryMatch, source: []const u8) bool {
    var step_count: u32 = 0;
    const steps = c.ts_query_predicates_for_pattern(q, m.pattern_index, &step_count);
    var i: usize = 0;
    var ops: [MAX_OPERANDS]Operand = undefined;
    while (i < step_count) {
        if (steps[i].type != c.TSQueryPredicateStepTypeString) {
            i = skipToDone(steps, step_count, i);
            continue;
        }
        const op = stringVal(q, steps[i].value_id);
        i += 1;
        var n: usize = 0;
        while (i < step_count and steps[i].type != c.TSQueryPredicateStepTypeDone) : (i += 1) {
            if (n >= MAX_OPERANDS) {
                i = skipToDone(steps, step_count, i);
                break;
            }
            const st = steps[i];
            if (st.type == c.TSQueryPredicateStepTypeString) {
                ops[n] = .{ .is_str = true, .str = stringVal(q, st.value_id), .cap_id = 0 };
            } else {
                ops[n] = .{ .is_str = false, .str = "", .cap_id = st.value_id };
            }
            n += 1;
        }
        if (i < step_count and steps[i].type == c.TSQueryPredicateStepTypeDone) i += 1;
        if (!evalOp(q, m, source, op, ops[0..n])) return false;
    }
    return true;
}

fn skipToDone(steps: [*c]const c.TSQueryPredicateStep, count: u32, start: usize) usize {
    var i = start;
    while (i < count and steps[i].type != c.TSQueryPredicateStepTypeDone) : (i += 1) {}
    if (i < count) i += 1; // consume the Done sentinel
    return i;
}

fn evalOp(q: *c.TSQuery, m: *c.TSQueryMatch, source: []const u8, op: []const u8, ops: []Operand) bool {
    _ = q;
    if (std.mem.eql(u8, op, "eq?")) {
        if (ops.len < 2) return true;
        const t0 = captureText(m, ops[0], source) orelse return false;
        if (ops[1].is_str) return std.mem.eql(u8, t0, ops[1].str);
        const t1 = captureText(m, ops[1], source) orelse return false;
        return std.mem.eql(u8, t0, t1);
    }
    if (std.mem.eql(u8, op, "any-of?")) {
        if (ops.len < 2) return true;
        const t0 = captureText(m, ops[0], source) orelse return false;
        for (ops[1..]) |o| if (o.is_str and std.mem.eql(u8, t0, o.str)) return true;
        return false;
    }
    if (std.mem.eql(u8, op, "lua-match?")) {
        if (ops.len < 2 or !ops[1].is_str) return false;
        const t0 = captureText(m, ops[0], source) orelse return false;
        return lua_match.luaMatch(t0, ops[1].str);
    }
    return true; // unknown predicate / directive (#set!, #offset!, #match?, ...): ignore
}

fn captureText(m: *c.TSQueryMatch, op: Operand, source: []const u8) ?[]const u8 {
    if (op.is_str) return op.str;
    var i: usize = 0;
    while (i < m.capture_count) : (i += 1) {
        if (m.captures[i].index == op.cap_id) {
            const node = m.captures[i].node;
            const sb: usize = @intCast(c.ts_node_start_byte(node));
            const eb: usize = @intCast(c.ts_node_end_byte(node));
            if (sb > source.len or eb > source.len or eb < sb) return null;
            return source[sb..eb];
        }
    }
    return null;
}

fn stringVal(q: *c.TSQuery, id: u32) []const u8 {
    var len: u32 = 0;
    const ptr = c.ts_query_string_value_for_id(q, id, &len);
    if (ptr == null or len == 0) return "";
    return ptr[0..len];
}
