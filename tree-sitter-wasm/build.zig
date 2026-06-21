const std = @import("std");

/// One row per grammar compiled into the wasm. `name` matches the
/// `tree_sitter_<name>` C symbol and the `<name>_highlights` anonymous import
/// (see src/languages.zig). bash is first — `highlight()` defaults to it.
/// Keep this order in sync with src/languages.zig.
const Lang = struct {
    name: []const u8,
    grammar: []const u8, // zon dep name (each grammar is a C-only dep)
    parser: []const u8, // path to parser.c (relative to dep root)
    scanner: ?[]const u8, // optional external scanner
    extra: []const []const u8 = &.{}, // extra .c TUs (yaml schemas)
    include: []const u8, // dir holding tree_sitter/parser.h (this grammar's own)
    /// Highlight query source. null = the grammar's own bundled
    /// `queries/highlights.scm` (version-matched → no drift). Non-null = a zon
    /// dep name (bash keeps its already-shipped nvim query).
    query: ?[]const u8,
};

const LANGS = [_]Lang{
    .{ .name = "bash", .grammar = "tree-sitter-bash", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = "nvim-treesitter-queries-bash" },
    .{ .name = "javascript", .grammar = "tree-sitter-javascript", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "typescript", .grammar = "tree-sitter-typescript", .parser = "typescript/src/parser.c", .scanner = "typescript/src/scanner.c", .include = "typescript/src", .query = null },
    .{ .name = "json", .grammar = "tree-sitter-json", .parser = "src/parser.c", .scanner = null, .include = "src", .query = null },
    .{ .name = "python", .grammar = "tree-sitter-python", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "c", .grammar = "tree-sitter-c", .parser = "src/parser.c", .scanner = null, .include = "src", .query = null },
    .{ .name = "cpp", .grammar = "tree-sitter-cpp", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "cuda", .grammar = "tree-sitter-cuda", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "go", .grammar = "tree-sitter-go", .parser = "src/parser.c", .scanner = null, .include = "src", .query = null },
    .{ .name = "rust", .grammar = "tree-sitter-rust", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "zig", .grammar = "tree-sitter-zig", .parser = "src/parser.c", .scanner = null, .include = "src", .query = null }, // v1.1.2 tag: no build.zig.zon → pure C dep
    .{ .name = "toml", .grammar = "tree-sitter-toml", .parser = "src/parser.c", .scanner = "src/scanner.c", .include = "src", .query = null },
    .{ .name = "yaml", .grammar = "tree-sitter-yaml", .parser = "src/parser.c", .scanner = "src/scanner.c", .extra = &[_][]const u8{ "src/schema.core.c", "src/schema.json.c", "src/schema.legacy.c" }, .include = "src", .query = null },
};

const C_FLAGS: []const []const u8 = &.{"-std=c11"};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{ .cpu_arch = .wasm32, .os_tag = .wasi },
    });
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSmall });

    // Pass target + optimize so tree-sitter's own build.zig compiles for wasm32-wasi.
    const ts_dep = b.dependency("tree-sitter", .{ .target = target, .optimize = optimize });
    const ts_lib = ts_dep.artifact("tree-sitter");

    // One write-files dir holds every language's highlights.scm + a tiny
    // @embedFile wrapper, so each query ships inside the binary with no runtime
    // file dependency.
    const wf = b.addWriteFiles();

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    mod.linkLibrary(ts_lib);
    // Translate tree-sitter's C API header at build time (replaces deprecated
    // @cImport). api.h pulls only libc headers, so link_libc is enough.
    const c_tc = b.addTranslateC(.{
        .root_source_file = ts_dep.path("lib/include/tree_sitter/api.h"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addImport("c", c_tc.createModule());

    inline for (LANGS) |lang| {
        const dep = b.dependency(lang.grammar, .{});

        // Embed the highlight query as `<name>_highlights`. Default to the
        // grammar's own bundled `queries/highlights.scm` (version-matched, so the
        // query never drifts from the grammar); bash keeps its shipped nvim query.
        const scm_src: std.Build.LazyPath = if (lang.query) |q|
            b.dependency(q, .{}).path("queries/highlights.scm")
        else
            dep.path("queries/highlights.scm");
        const scm = "highlights_" ++ lang.name ++ ".scm";
        const wrap = "highlights_" ++ lang.name ++ "_wrap.zig";
        _ = wf.addCopyFile(scm_src, scm);
        _ = wf.add(wrap, "pub const scm: []const u8 = @embedFile(\"" ++ scm ++ "\");\n");
        mod.addAnonymousImport(lang.name ++ "_highlights", .{
            .root_source_file = wf.getDirectory().path(b, wrap),
        });

        // One static lib per grammar, each with ONLY its own include dir on the
        // search path, so a grammar's `#include <tree_sitter/parser.h>` (toml
        // uses angle brackets) resolves to its own parser.h — not another
        // grammar's, whose macro signature may differ. External scanners use the
        // `tree_sitter_<name>_external_scanner_*` prefix, so multiple grammars
        // link into one binary without symbol collision.
        const gmod = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
        gmod.addIncludePath(dep.path(lang.include));
        gmod.addCSourceFile(.{ .file = dep.path(lang.parser), .flags = C_FLAGS });
        if (lang.scanner) |sc| gmod.addCSourceFile(.{ .file = dep.path(sc), .flags = C_FLAGS });
        inline for (lang.extra) |ex| gmod.addCSourceFile(.{ .file = dep.path(ex), .flags = C_FLAGS });
        const lib = b.addLibrary(.{ .name = "ts-" ++ lang.name, .root_module = gmod, .linkage = .static });
        mod.linkLibrary(lib);
    }

    const exe = b.addExecutable(.{
        .name = "tree-sitter-wasm",
        .root_module = mod,
    });
    exe.rdynamic = true;

    b.installArtifact(exe);
}
