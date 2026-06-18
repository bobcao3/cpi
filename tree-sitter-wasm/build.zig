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

    const exe = b.addExecutable(.{
        .name = "tree-sitter-wasm",
        .root_module = mod,
    });
    exe.rdynamic = true;

    b.installArtifact(exe);
}
