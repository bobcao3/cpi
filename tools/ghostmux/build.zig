const std = @import("std");

fn configure(module: *std.Build.Module, b: *std.Build, target: std.Build.ResolvedTarget, kb: *std.Build.Dependency, stb: *std.Build.Dependency) void {
    module.addAnonymousImport("fonts", .{ .root_source_file = b.path("fonts/assets.zig") });
    module.addIncludePath(b.path("src"));
    if (target.result.os.tag == .linux or target.result.os.tag == .freebsd or target.result.os.tag == .netbsd or target.result.os.tag == .openbsd or target.result.os.tag == .dragonfly) module.linkSystemLibrary("util", .{});
    if (target.result.os.tag == .windows) {
        module.linkSystemLibrary("kernel32", .{});
        module.linkSystemLibrary("advapi32", .{});
    }
    module.addIncludePath(kb.path(""));
    module.addIncludePath(stb.path(""));
    module.addCSourceFile(.{ .file = b.path("src/font_engine.c"), .flags = &.{"-std=c23"} });
}

pub fn build(b: *std.Build) void {
    var target = b.standardTargetOptions(.{});
    if (target.result.os.tag == .windows) {
        if (target.query.os_version_min == null) {
            var query = target.query;
            query.os_version_min = .{ .windows = .win10_rs5 };
            target = b.resolveTargetQuery(query);
        } else if (@intFromEnum(target.result.os.version_range.windows.min) < @intFromEnum(std.Target.Os.WindowsVersion.win10_rs5)) {
            std.debug.panic("ghostmux requires Windows 10 RS5 or newer", .{});
        }
    }
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });
    const ghostty = b.dependency("ghostty", .{ .target = target, .optimize = optimize, .simd = false, .@"emit-lib-vt" = true, .@"vt-features" = "-all,+render-state" });
    const kb = b.dependency("kb", .{});
    const stb = b.dependency("stb", .{});
    const executable = b.addExecutable(.{
        .name = "ghostmux",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .imports = &.{.{ .name = "ghostty-vt", .module = ghostty.module("ghostty-vt") }},
        }),
    });
    configure(executable.root_module, b, target, kb, stb);
    b.installArtifact(executable);
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/native_tests.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .imports = &.{.{ .name = "ghostty-vt", .module = ghostty.module("ghostty-vt") }},
        }),
    });
    configure(tests.root_module, b, target, kb, stb);
    const test_options = b.addOptions();
    test_options.addOptionPath("binary", executable.getEmittedBin());
    test_options.addOption([]const u8, "project", b.build_root.path orelse ".");
    tests.root_module.addImport("test_options", test_options.createModule());
    const run_tests = b.addRunArtifact(tests);
    run_tests.setCwd(.{ .cwd_relative = b.cache_root.path orelse ".zig-cache" });
    b.step("test", "Run tests").dependOn(&run_tests.step);
    for ([_][]const u8{ "THIRD_PARTY_NOTICES.md", "fonts/OFL.txt", "fonts/LICENSE-nerd-fonts.txt", "fonts/ATTRIBUTIONS-nerd-fonts.md", "fonts/MANIFEST.sha256" }) |path| {
        b.installFile(path, b.fmt("share/ghostmux/{s}", .{path}));
    }
    inline for (.{ ghostty, kb, stb }, .{ "ghostty", "kb", "stb" }) |dependency, name| {
        const license = b.addInstallFile(dependency.path("LICENSE"), "share/ghostmux/LICENSE-" ++ name);
        b.getInstallStep().dependOn(&license.step);
    }
    const run = b.addRunArtifact(executable);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run ghostmux").dependOn(&run.step);
}
