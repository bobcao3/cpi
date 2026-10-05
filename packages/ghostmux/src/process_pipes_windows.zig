const std = @import("std");
const w = std.os.windows;
const native = @import("native.zig");
const arguments = @import("terminal_windows_arguments.zig");
const terminal = @import("terminal_windows.zig");
const wire = @import("wire.zig");
const handle_inherit: w.DWORD = 0x00000001;
const generic_read: w.DWORD = 0x80000000;
const share_read: w.DWORD = 0x00000001;
const share_write: w.DWORD = 0x00000002;
const open_existing: w.DWORD = 3;
const normal_attributes: w.DWORD = 0x00000080;

// Zig's spawn inherits all inheritable handles, without a handle-list attribute.
pub fn start(allocator: std.mem.Allocator, io: std.Io, request: wire.Request) !terminal.Spawn {
    const command = try arguments.command_line(allocator, request.argv);
    var environment = try arguments.environment_exact(allocator, request.env);
    defer environment.deinit();
    const block = try environment.createWindowsBlock(allocator, .{});
    const directory = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, request.cwd.?);
    const executable = try arguments.executable(allocator, io, request.cwd.?, request.argv[0], environment.get("PATH") orelse "");
    var owner: terminal.Terminal = .{};
    errdefer owner.deinit(io);
    var security: w.SECURITY_ATTRIBUTES = .{ .nLength = @sizeOf(w.SECURITY_ATTRIBUTES), .lpSecurityDescriptor = null, .bInheritHandle = .TRUE };
    var reader: w.HANDLE = undefined;
    var writer: w.HANDLE = undefined;
    if (native.CreatePipe(&reader, &writer, &security, 65536) == .FALSE) return error.ProcessPipeFailed;
    owner.output = reader;
    defer w.CloseHandle(writer);
    if (native.SetHandleInformation(reader, handle_inherit, 0) == .FALSE) return error.ProcessPipeFailed;
    const input = native.CreateFileW(std.unicode.utf8ToUtf16LeStringLiteral("NUL"), generic_read, share_read | share_write, &security, open_existing, normal_attributes, null);
    if (input == w.INVALID_HANDLE_VALUE) return error.ProcessInputFailed;
    defer w.CloseHandle(input);
    var handles = [_]w.HANDLE{ input, writer };
    var attribute_bytes: usize = 0;
    _ = native.InitializeProcThreadAttributeList(null, 1, 0, &attribute_bytes);
    if (attribute_bytes == 0 or attribute_bytes > 65536) return error.ProcessAttributesFailed;
    const attribute_buffer = try allocator.alignedAlloc(u8, .of(usize), attribute_bytes);
    const attributes: *anyopaque = attribute_buffer.ptr;
    if (native.InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes) == .FALSE) return error.ProcessAttributesFailed;
    defer native.DeleteProcThreadAttributeList(attributes);
    if (native.UpdateProcThreadAttribute(attributes, 0, native.handle_list_attribute, &handles, @sizeOf(@TypeOf(handles)), null, null) == .FALSE) return error.ProcessAttributesFailed;
    const job = native.CreateJobObjectW(null, null) orelse return error.ProcessJobFailed;
    owner.job = job;
    const limits: native.JobLimits = .{ .flags = native.kill_on_job_close };
    if (native.SetInformationJobObject(job, native.extended_limit_information, &limits, @sizeOf(native.JobLimits)) == .FALSE) return error.ProcessJobFailed;
    var startup: native.StartupInfo = .{ .base = std.mem.zeroes(w.STARTUPINFOW), .attributes = attributes };
    startup.base.cb = @sizeOf(native.StartupInfo);
    startup.base.dwFlags = w.STARTF_USESTDHANDLES;
    startup.base.hStdInput = input;
    startup.base.hStdOutput = writer;
    startup.base.hStdError = writer;
    var information: w.PROCESS.INFORMATION = undefined;
    if (w.kernel32.CreateProcessW(executable.ptr, command.ptr, null, null, .TRUE, .{
        .extended_startupinfo_present = true,
        .create_unicode_environment = true,
        .create_suspended = true,
        .create_no_window = true,
    }, block.slice.ptr, directory.ptr, &startup.base, &information) == .FALSE) return error.ProcessSpawnFailed;
    var child: std.process.Child = .{ .id = information.hProcess, .thread_handle = information.hThread, .stdin = null, .stdout = null, .stderr = null, .request_resource_usage_statistics = false };
    errdefer child.kill(io);
    if (native.AssignProcessToJobObject(job, information.hProcess) == .FALSE) return error.ProcessJobFailed;
    if (native.ResumeThread(information.hThread) == std.math.maxInt(w.DWORD)) return error.ProcessSpawnFailed;
    const output: std.Io.File = .{ .handle = reader, .flags = .{ .nonblocking = false } };
    return .{ .child = child, .input = null, .output = output, .pid = @bitCast(information.dwProcessId), .terminal = owner };
}
