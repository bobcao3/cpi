const std = @import("std");
const w = std.os.windows;

pub fn start(allocator: std.mem.Allocator, executable: []const u8, path: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const temporary = arena.allocator();
    const command = try @import("terminal_windows_arguments.zig").command_line(temporary, &.{ executable, "--serve", path });
    const application = try std.unicode.wtf8ToWtf16LeAllocZ(temporary, executable);
    var startup = std.mem.zeroes(w.STARTUPINFOW);
    startup.cb = @sizeOf(w.STARTUPINFOW);
    var information: w.PROCESS.INFORMATION = undefined;
    if (w.kernel32.CreateProcessW(application.ptr, command.ptr, null, null, .FALSE, .{
        .create_no_window = true,
    }, null, null, &startup, &information) == .FALSE) return error.DaemonSpawnFailed;
    w.CloseHandle(information.hThread);
    w.CloseHandle(information.hProcess);
}
