const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });
    const ghostty = b.dependency("ghostty", .{ .target = target, .optimize = optimize, .simd = false, .@"emit-lib-vt" = true, .@"vt-features" = "-all,+render-state" });
    const kb = b.dependency("kb", .{});
    const stb = b.dependency("stb", .{});
    const executable = b.addExecutable(.{
        .name = "terminal-capture",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .imports = &.{.{ .name = "ghostty-vt", .module = ghostty.module("ghostty-vt") }},
        }),
    });
    executable.root_module.addAnonymousImport("fonts", .{ .root_source_file = b.path("fonts/assets.zig") });
    if (target.result.os.tag == .linux) executable.root_module.linkSystemLibrary("util", .{});
    executable.root_module.addIncludePath(kb.path(""));
    executable.root_module.addIncludePath(stb.path(""));
    executable.root_module.addCSourceFile(.{ .file = b.path("src/font_engine.c"), .flags = &.{"-std=c23"} });
    b.installArtifact(executable);
    for ([_][]const u8{ "THIRD_PARTY_NOTICES.md", "fonts/OFL.txt", "fonts/LICENSE-nerd-fonts.txt", "fonts/ATTRIBUTIONS-nerd-fonts.md", "fonts/MANIFEST.sha256" }) |path| {
        b.installFile(path, b.fmt("share/terminal-capture/{s}", .{path}));
    }
    inline for (.{ ghostty, kb, stb }, .{ "ghostty", "kb", "stb" }) |dependency, name| {
        const license = b.addInstallFile(dependency.path("LICENSE"), "share/terminal-capture/LICENSE-" ++ name);
        b.getInstallStep().dependOn(&license.step);
    }
    const run = b.addRunArtifact(executable);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run terminal-capture").dependOn(&run.step);
}
