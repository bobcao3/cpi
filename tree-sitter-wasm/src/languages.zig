//! Language registry: one entry per grammar compiled into the wasm.
//!
//! Each grammar contributes an extern C `tree_sitter_<name>()` symbol (linked
//! from build.zig) and an embedded nvim highlights query (the `<name>_highlights`
//! anonymous import wired in build.zig). Order MUST match build.zig LANGS —
//! bash is first so `highlight()` can default to index 0.

const std = @import("std");
const c = @import("c");

extern fn tree_sitter_bash() ?*const c.TSLanguage;
extern fn tree_sitter_javascript() ?*const c.TSLanguage;
extern fn tree_sitter_typescript() ?*const c.TSLanguage;
extern fn tree_sitter_json() ?*const c.TSLanguage;
extern fn tree_sitter_python() ?*const c.TSLanguage;
extern fn tree_sitter_c() ?*const c.TSLanguage;
extern fn tree_sitter_cpp() ?*const c.TSLanguage;
extern fn tree_sitter_cuda() ?*const c.TSLanguage;
extern fn tree_sitter_go() ?*const c.TSLanguage;
extern fn tree_sitter_rust() ?*const c.TSLanguage;
extern fn tree_sitter_zig() ?*const c.TSLanguage;
extern fn tree_sitter_toml() ?*const c.TSLanguage;
extern fn tree_sitter_yaml() ?*const c.TSLanguage;

const bash_hl = @import("bash_highlights");
const javascript_hl = @import("javascript_highlights");
const typescript_hl = @import("typescript_highlights");
const json_hl = @import("json_highlights");
const python_hl = @import("python_highlights");
const c_hl = @import("c_highlights");
const cpp_hl = @import("cpp_highlights");
const cuda_hl = @import("cuda_highlights");
const go_hl = @import("go_highlights");
const rust_hl = @import("rust_highlights");
const zig_hl = @import("zig_highlights");
const toml_hl = @import("toml_highlights");
const yaml_hl = @import("yaml_highlights");

pub const Lang = struct {
    name: []const u8,
    lang: *const fn () callconv(.c) ?*const c.TSLanguage,
    query: []const u8,
};

pub const LANGS = [_]Lang{
    .{ .name = "bash", .lang = tree_sitter_bash, .query = bash_hl.scm },
    .{ .name = "javascript", .lang = tree_sitter_javascript, .query = javascript_hl.scm },
    .{ .name = "typescript", .lang = tree_sitter_typescript, .query = typescript_hl.scm },
    .{ .name = "json", .lang = tree_sitter_json, .query = json_hl.scm },
    .{ .name = "python", .lang = tree_sitter_python, .query = python_hl.scm },
    .{ .name = "c", .lang = tree_sitter_c, .query = c_hl.scm },
    .{ .name = "cpp", .lang = tree_sitter_cpp, .query = cpp_hl.scm },
    .{ .name = "cuda", .lang = tree_sitter_cuda, .query = cuda_hl.scm },
    .{ .name = "go", .lang = tree_sitter_go, .query = go_hl.scm },
    .{ .name = "rust", .lang = tree_sitter_rust, .query = rust_hl.scm },
    .{ .name = "zig", .lang = tree_sitter_zig, .query = zig_hl.scm },
    .{ .name = "toml", .lang = tree_sitter_toml, .query = toml_hl.scm },
    .{ .name = "yaml", .lang = tree_sitter_yaml, .query = yaml_hl.scm },
};

/// Index of `name` in LANGS (exact, case-sensitive), or null.
pub fn idByName(name: []const u8) ?usize {
    for (LANGS, 0..) |l, i| if (std.mem.eql(u8, l.name, name)) return i;
    return null;
}
