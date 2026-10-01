const std = @import("std");
const builtin = @import("builtin");
const posix_child = @import("test_child_posix.zig");
extern "kernel32" fn SetConsoleOutputCP(code_page: std.os.windows.UINT) callconv(.winapi) std.os.windows.BOOL;

pub const Program = enum { emit, hold, replay, replay_success, gated, pipe_eof, marker, environment, signals, family, family_exit, echo, queries };

pub fn main(init: std.process.Init) !void {
    const program = @import("child_options").program;
    const io = init.io;
    if (builtin.os.tag == .windows and try std.Io.File.stdout().isTty(io)) {
        if (SetConsoleOutputCP(65001) == .FALSE) return error.ConsoleEncodingFailed;
    }
    switch (program) {
        .emit, .hold, .replay, .replay_success, .gated => {
            if (program == .gated) try wait_file(io, "start");
            try emit(io);
            if (program == .hold) try std.Io.sleep(io, .fromSeconds(120), .awake);
            if (program == .replay or program == .replay_success or program == .gated) try wait_file(io, "release");
            if (program == .replay or program == .replay_success) try std.Io.File.stdout().writeStreamingAll(io, "tail");
            std.process.exit(if (program == .replay_success) 0 else 7);
        },
        .pipe_eof => {
            var byte: [1]u8 = undefined;
            const count = std.Io.File.stdin().readStreaming(io, &.{&byte}) catch |err| switch (err) {
                error.EndOfStream => 0,
                else => return err,
            };
            if (count != 0) return error.ExpectedStdinEof;
            try std.Io.File.stdout().writeStreamingAll(io, "OUT\x00\xff");
            try std.Io.File.stderr().writeStreamingAll(io, "ERR\x00\xfe");
            try wait_file(io, "release");
            try std.Io.File.stdout().writeStreamingAll(io, "EOF");
            std.process.exit(7);
        },
        .marker => try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = "launched", .data = "launched" }),
        .environment => {
            const cwd = try std.process.currentPathAlloc(io, init.arena.allocator());
            const custom = init.environ_map.get("CUSTOM") orelse return error.MissingEnvironment;
            const text = try std.fmt.allocPrint(init.arena.allocator(), "{s}|{s}|{s}", .{ cwd, custom, if (try std.Io.File.stdin().isTty(io)) "True" else "False" });
            try std.Io.File.stdout().writeStreamingAll(io, text);
        },
        else => if (builtin.os.tag != .windows) try posix_child.run(init, @tagName(program)) else return error.UnsupportedProgram,
    }
}

fn emit(io: std.Io) !void {
    const input = try std.Io.Dir.cwd().openFile(io, "output", .{});
    defer input.close(io);
    if ((try input.stat(io)).size > 4 * 1024 * 1024) return error.OutputLimit;
    var buffer: [16 * 1024]u8 = undefined;
    for (0..257) |_| {
        const count = input.readStreaming(io, &.{&buffer}) catch |err| switch (err) {
            error.EndOfStream => return,
            else => return err,
        };
        if (count == 0) return;
        try std.Io.File.stdout().writeStreamingAll(io, buffer[0..count]);
    }
    return error.OutputLimit;
}

fn wait_file(io: std.Io, path: []const u8) !void {
    for (0..24000) |_| {
        _ = std.Io.Dir.cwd().statFile(io, path, .{}) catch |err| switch (err) {
            error.FileNotFound => {
                try std.Io.sleep(io, .fromMilliseconds(5), .awake);
                continue;
            },
            else => return err,
        };
        return;
    }
    return error.ReleaseDeadline;
}
