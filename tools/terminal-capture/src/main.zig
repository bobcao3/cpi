const std = @import("std");
const options = @import("options.zig");
const Session = @import("session.zig");
const protocol = @import("protocol.zig");
const client = @import("client.zig");

pub const std_options: std.Options = .{ .log_level = .warn };

pub fn main(init: std.process.Init) void {
    run(init) catch |err| {
        if (err == error.RemoteFailure) std.process.exit(1);
        var buffer: [256]u8 = undefined;
        const message = std.fmt.bufPrint(&buffer, "terminal-capture: {s}\n", .{@errorName(err)}) catch unreachable;
        std.Io.File.stderr().writeStreamingAll(init.io, message) catch {};
        std.process.exit(1);
    };
}

fn run(init: std.process.Init) !void {
    const allocator = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(allocator);
    defer allocator.free(args);
    if (args.len > 1 and std.mem.eql(u8, args[1], "--serve")) {
        if (@import("builtin").os.tag != .linux) return error.ServerRequiresLinux;
        if (args.len != 5) return error.InvalidServerArguments;
        const initial_fd = try std.fmt.parseInt(c_int, args[3], 10);
        const lock_fd = try std.fmt.parseInt(c_int, args[4], 10);
        if (initial_fd < 3 or lock_fd < 3 or initial_fd == lock_fd) return error.InvalidServerArguments;
        return @import("server.zig").run(allocator, io, args[2], initial_fd, lock_fd);
    }
    if (client.is_command(args)) {
        if (@import("builtin").os.tag != .linux) return error.ServerRequiresLinux;
        return client.run(init, args);
    }
    const config = try options.parse(args);
    if (config.help) {
        try std.Io.File.stdout().writeStreamingAll(io, options.help);
        try std.Io.File.stdout().writeStreamingAll(io, client.help);
        return;
    }
    const stdin = std.mem.eql(u8, config.input, "-");
    const input = if (stdin) std.Io.File.stdin() else try std.Io.Dir.cwd().openFile(io, config.input, .{});
    defer if (!stdin) input.close(io);
    var session: Session = undefined;
    try session.init(allocator, io, config);
    defer session.deinit();
    if (config.protocol) return protocol.run(allocator, io, input, &session, config.font_size);
    var buffer: [64 * 1024]u8 = undefined;
    while (true) {
        const count = input.readStreaming(io, &.{&buffer}) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        if (count == 0) break;
        try session.feed(buffer[0..count]);
    }
    if (config.png) |path| try protocol.screenshot(allocator, &session, path, config.font_size);
    if (config.text) |path| {
        const text = try session.capture(allocator, config.history, config.join);
        defer allocator.free(text);
        const stdout = std.mem.eql(u8, path, "-");
        const output = if (stdout) std.Io.File.stdout() else try std.Io.Dir.cwd().createFile(io, path, .{});
        defer if (!stdout) output.close(io);
        try output.writeStreamingAll(io, text);
        if (text.len != 0) try output.writeStreamingAll(io, "\n");
    }
}
