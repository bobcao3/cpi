//! Shared tree-sitter C API import. Kept in one place so both the parser
//! (main.zig) and the highlight query engine (highlight.zig) see identical
//! declarations without re-running @cImport per file.

pub const c = @cImport({
    @cInclude("tree_sitter/api.h");
});
