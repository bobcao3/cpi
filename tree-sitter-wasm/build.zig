const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{
            .cpu_arch = .wasm32,
            .os_tag = .wasi,
        },
    });
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSmall });

    // Pass target + optimize so tree-sitter's own build.zig
    // (line 11: b.standardTargetOptions(.{})) compiles for wasm32-wasi
    const ts_dep = b.dependency("tree-sitter", .{
        .target = target,
        .optimize = optimize,
    });
    const ts_lib = ts_dep.artifact("tree-sitter");

    const bash = b.dependency("tree-sitter-bash", .{});

    // Vendored bash highlight query (neovim-treesitter-queries-bash, fetched,
    // not copied). Embedded into the wasm via a generated @embedFile wrapper so
    // the query ships inside the binary with no runtime file dependency.
    const queries = b.dependency("nvim-treesitter-queries-bash", .{});
    const wf = b.addWriteFiles();
    _ = wf.addCopyFile(queries.path("queries/highlights.scm"), "highlights.scm");
    _ = wf.add("highlights_wrap.zig", "pub const scm: []const u8 = @embedFile(\"highlights.scm\");\n");

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    mod.linkLibrary(ts_lib);
    mod.addIncludePath(ts_dep.path("lib/include"));
    mod.addIncludePath(bash.path("src"));
    mod.addCSourceFile(.{ .file = bash.path("src/parser.c"), .flags = &.{"-std=c11"} });
    mod.addCSourceFile(.{ .file = bash.path("src/scanner.c"), .flags = &.{"-std=c11"} });

    mod.addAnonymousImport("bash_highlights", .{
        .root_source_file = wf.getDirectory().path(b, "highlights_wrap.zig"),
    });

    const exe = b.addExecutable(.{
        .name = "tree-sitter-wasm",
        .root_module = mod,
    });
    exe.rdynamic = true;

    b.installArtifact(exe);
}
