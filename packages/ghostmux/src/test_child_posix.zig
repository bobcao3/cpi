const std = @import("std");
const p = std.posix;
const builtin = @import("builtin");
const resize_request: c_int = @bitCast(@as(u32, if (builtin.os.tag == .macos) 0x40000000 | (@sizeOf(p.winsize) << 16) | ('t' << 8) | 104 else p.system.T.IOCGWINSZ));
extern "c" fn tcgetattr(fd: c_int, term: *p.termios) c_int;
extern "c" fn tcsetattr(fd: c_int, action: c_int, term: *const p.termios) c_int;
extern "c" fn cfmakeraw(term: *p.termios) void;
extern "c" fn fork() c_int;
extern "c" fn sleep(seconds: c_uint) c_uint;
extern "c" fn read(fd: c_int, buffer: [*]u8, length: usize) isize;
extern "c" fn poll(fds: [*]p.pollfd, count: usize, timeout: c_int) c_int;
var received = std.atomic.Value(bool).init(false);

fn signal_received(_: p.SIG) callconv(.c) void {
    received.store(true, .release);
}

pub fn run(init: std.process.Init, comptime mode: []const u8) !void {
    if (std.mem.eql(u8, mode, "signals")) {
        const action: p.Sigaction = .{ .handler = .{ .handler = signal_received }, .mask = p.sigemptyset(), .flags = 0 };
        p.sigaction(.USR1, &action, null);
        try std.Io.File.stdout().writeStreamingAll(init.io, "ready");
        for (0..6000) |_| {
            if (received.swap(false, .acq_rel)) try std.Io.File.stdout().writeStreamingAll(init.io, "USR1");
            try std.Io.sleep(init.io, .fromMilliseconds(20), .awake);
        }
    } else if (std.mem.eql(u8, mode, "family") or std.mem.eql(u8, mode, "family_exit")) {
        const child = fork();
        if (child < 0) return error.ForkFailed;
        if (child == 0) {
            for (0..120) |_| _ = sleep(1);
            p.system._exit(0);
        }
        var buffer: [32]u8 = undefined;
        const pid = try std.fmt.bufPrint(&buffer, "{d}", .{child});
        try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = "child", .data = pid });
        try std.Io.File.stdout().writeStreamingAll(init.io, "ready");
        if (std.mem.eql(u8, mode, "family_exit")) std.process.exit(9);
        try std.Io.sleep(init.io, .fromSeconds(120), .awake);
    } else if (std.mem.eql(u8, mode, "echo")) {
        try echo(init.io);
    } else if (std.mem.eql(u8, mode, "queries")) {
        try queries(init);
    } else return error.UnknownMode;
}

fn size() !p.winsize {
    var geometry: p.winsize = undefined;
    if (p.system.ioctl(0, resize_request, @intFromPtr(&geometry)) != 0) return error.GeometryFailed;
    return geometry;
}

fn echo(io: std.Io) !void {
    var previous: p.winsize = std.mem.zeroes(p.winsize);
    var line: [4096]u8 = undefined;
    var used: usize = 0;
    for (0..6000) |_| {
        const current = try size();
        if (current.col != previous.col or current.row != previous.row) {
            var buffer: [64]u8 = undefined;
            const text = try std.fmt.bufPrint(&buffer, "SIZE {d} {d}\n", .{ current.col, current.row });
            try std.Io.File.stdout().writeStreamingAll(io, text);
            previous = current;
        }
        var descriptors = [_]p.pollfd{.{ .fd = 0, .events = p.POLL.IN, .revents = 0 }};
        if (poll(&descriptors, 1, 20) <= 0) continue;
        const count = read(0, line[used..].ptr, line.len - used);
        if (count <= 0) return;
        used += @intCast(count);
        if (std.mem.indexOfScalar(u8, line[0..used], '\n')) |end| {
            try std.Io.File.stdout().writeStreamingAll(io, "GOT:");
            try std.Io.File.stdout().writeStreamingAll(io, line[0 .. end + 1]);
            used = 0;
        }
        if (used == line.len) return error.LineTooLong;
    }
}

fn query(io: std.Io, sequence: []const u8, end: u8, buffer: *[128]u8) ![]const u8 {
    try std.Io.File.stdout().writeStreamingAll(io, sequence);
    for (buffer, 0..) |*byte, index| {
        if (read(0, @ptrCast(byte), 1) != 1) return error.QueryReadFailed;
        if (byte.* == end) return buffer[0 .. index + 1];
    }
    return error.UnterminatedReply;
}

fn queries(init: std.process.Init) !void {
    var term: p.termios = undefined;
    if (tcgetattr(0, &term) != 0) return error.TerminalModeFailed;
    cfmakeraw(&term);
    if (tcsetattr(0, 0, &term) != 0) return error.TerminalModeFailed;
    var position_buffer: [128]u8 = undefined;
    var pixels_buffer: [128]u8 = undefined;
    const position = try query(init.io, "\x1b[6n", 'R', &position_buffer);
    const pixels = try query(init.io, "\x1b[16t", 't', &pixels_buffer);
    const geometry = try size();
    const text = try std.fmt.allocPrint(init.arena.allocator(), "[{f},{f},[{d},{d},{d},{d}]]\r\n", .{ std.json.fmt(position, .{}), std.json.fmt(pixels, .{}), geometry.row, geometry.col, geometry.xpixel, geometry.ypixel });
    try std.Io.File.stdout().writeStreamingAll(init.io, text);
    var byte: [1]u8 = undefined;
    _ = read(0, &byte, 1);
}
