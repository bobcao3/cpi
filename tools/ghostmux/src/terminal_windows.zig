const std = @import("std");
const w = std.os.windows;
const native = @import("native.zig");
const wire = @import("wire.zig");
const arguments = @import("terminal_windows_arguments.zig");

pub const Spawn = struct { child: std.process.Child, input: ?std.Io.File, output: std.Io.File, pid: i32, terminal: Terminal };

pub const start_pipes = @import("process_pipes_windows.zig").start;

pub const Terminal = struct {
    input: ?w.HANDLE = null,
    output: ?w.HANDLE = null,
    console: ?w.HANDLE = null,
    job: ?w.HANDLE = null,
    close_group: std.Io.Group = .init,

    pub fn resize(self: *Terminal, cols: u16, rows: u16, _: u32, _: u32) !void {
        if (self.console == null and self.input == null) return error.NotPty;
        const size = try dimensions(cols, rows);
        const console = self.console orelse return error.TerminalClosed;
        if (native.ResizePseudoConsole(console, size) < 0) return error.ConPtyResizeFailed;
    }

    pub fn finish_output(self: *Terminal, io: std.Io) void {
        if (self.console) |console| {
            self.close_group.concurrent(io, native.ClosePseudoConsole, .{console}) catch return;
            self.console = null;
        }
    }

    pub fn stop(self: *Terminal, _: i32) void {
        if (self.job) |job| _ = native.TerminateJobObject(job, 137);
    }

    pub fn signal(self: *Terminal, _: i32, name: []const u8) !void {
        _ = try @import("process_signal.zig").parse(name);
        const job = self.job orelse return error.ProcessNotFound;
        if (native.TerminateJobObject(job, 137) == .FALSE) return error.ProcessTerminationFailed;
    }

    pub fn deinit(self: *Terminal, io: std.Io) void {
        if (self.output) |handle| {
            self.output = null;
            const file = file_from_handle(handle);
            file.close(io);
        }
        if (self.input) |handle| {
            self.input = null;
            const file = file_from_handle(handle);
            file.close(io);
        }
        if (self.console) |console| {
            self.console = null;
            native.ClosePseudoConsole(console);
        }
        self.close_group.await(io) catch self.close_group.cancel(io);
        if (self.job) |job| {
            self.job = null;
            w.CloseHandle(job);
        }
    }
};

pub fn start(allocator: std.mem.Allocator, io: std.Io, request: wire.Request, _: u32, _: u32) !Spawn {
    const size = try dimensions(request.cols, request.rows);
    const command = try arguments.command_line(allocator, request.argv);
    var environment = try arguments.environment(allocator, request.env);
    defer environment.deinit();
    const block = try environment.createWindowsBlock(allocator, .{});
    const directory = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, request.cwd.?);
    const executable = try arguments.executable(allocator, io, request.cwd.?, request.argv[0], environment.get("PATH") orelse "");
    var terminal: Terminal = .{};
    errdefer terminal.deinit(io);
    var console_input: w.HANDLE = undefined;
    var host_input: w.HANDLE = undefined;
    if (native.CreatePipe(&console_input, &host_input, null, 65536) == .FALSE) return error.ConPtyPipeFailed;
    terminal.input = host_input;
    defer w.CloseHandle(console_input);
    var host_output: w.HANDLE = undefined;
    var console_output: w.HANDLE = undefined;
    if (native.CreatePipe(&host_output, &console_output, null, 65536) == .FALSE) return error.ConPtyPipeFailed;
    terminal.output = host_output;
    defer w.CloseHandle(console_output);
    var console: w.HANDLE = undefined;
    if (native.CreatePseudoConsole(size, console_input, console_output, 0, &console) < 0) return error.ConPtyCreationFailed;
    terminal.console = console;
    var attribute_bytes: usize = 0;
    _ = native.InitializeProcThreadAttributeList(null, 1, 0, &attribute_bytes);
    if (attribute_bytes == 0 or attribute_bytes > 65536) return error.ConPtyAttributesFailed;
    const attribute_buffer = try allocator.alignedAlloc(u8, .of(usize), attribute_bytes);
    const attributes: *anyopaque = attribute_buffer.ptr;
    if (native.InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes) == .FALSE) return error.ConPtyAttributesFailed;
    defer native.DeleteProcThreadAttributeList(attributes);
    if (native.UpdateProcThreadAttribute(attributes, 0, native.pseudo_console_attribute, console, @sizeOf(w.HANDLE), null, null) == .FALSE) return error.ConPtyAttributesFailed;
    const job = native.CreateJobObjectW(null, null) orelse return error.ConPtyJobFailed;
    terminal.job = job;
    const limits: native.JobLimits = .{ .flags = native.kill_on_job_close };
    if (native.SetInformationJobObject(job, native.extended_limit_information, &limits, @sizeOf(native.JobLimits)) == .FALSE) return error.ConPtyJobFailed;
    var startup: native.StartupInfo = .{ .base = std.mem.zeroes(w.STARTUPINFOW), .attributes = attributes };
    startup.base.cb = @sizeOf(native.StartupInfo);
    var information: w.PROCESS.INFORMATION = undefined;
    if (w.kernel32.CreateProcessW(executable.ptr, command.ptr, null, null, .FALSE, .{
        .extended_startupinfo_present = true,
        .create_unicode_environment = true,
        .create_suspended = true,
    }, block.slice.ptr, directory.ptr, &startup.base, &information) == .FALSE) return error.ConPtySpawnFailed;
    var child: std.process.Child = .{ .id = information.hProcess, .thread_handle = information.hThread, .stdin = null, .stdout = null, .stderr = null, .request_resource_usage_statistics = false };
    errdefer child.kill(io);
    if (native.AssignProcessToJobObject(job, information.hProcess) == .FALSE) return error.ConPtyJobFailed;
    if (native.ResumeThread(information.hThread) == std.math.maxInt(w.DWORD)) return error.ConPtySpawnFailed;
    return .{ .child = child, .input = file_from_handle(host_input), .output = file_from_handle(host_output), .pid = @bitCast(information.dwProcessId), .terminal = terminal };
}

fn file_from_handle(handle: w.HANDLE) std.Io.File {
    return .{ .handle = handle, .flags = .{ .nonblocking = false } };
}

fn dimensions(cols: u16, rows: u16) !w.COORD {
    if (cols == 0 or rows == 0 or cols > std.math.maxInt(i16) or rows > std.math.maxInt(i16)) return error.InvalidGeometry;
    return .{ .X = @intCast(cols), .Y = @intCast(rows) };
}
