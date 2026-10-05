const w = @import("std").os.windows;
pub const StartupInfo = extern struct { base: w.STARTUPINFOW, attributes: ?*anyopaque };
pub const JobLimits = extern struct {
    process_time: i64 = 0,
    job_time: i64 = 0,
    flags: w.DWORD = 0,
    min_working_set: usize = 0,
    max_working_set: usize = 0,
    active_process_limit: w.DWORD = 0,
    affinity: usize = 0,
    priority: w.DWORD = 0,
    scheduling: w.DWORD = 0,
    io_counters: [6]u64 = @splat(0),
    process_memory: usize = 0,
    job_memory: usize = 0,
    peak_process_memory: usize = 0,
    peak_job_memory: usize = 0,
};
pub const pseudo_console_attribute: usize = 0x00020016;
pub const handle_list_attribute: usize = 0x00020002;
pub const kill_on_job_close: w.DWORD = 0x00002000;
pub const extended_limit_information: c_int = 9;
pub extern "kernel32" fn CreatePipe(read: *w.HANDLE, write: *w.HANDLE, attributes: ?*w.SECURITY_ATTRIBUTES, size: w.DWORD) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn SetHandleInformation(handle: w.HANDLE, mask: w.DWORD, flags: w.DWORD) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn CreateFileW(name: [*:0]const u16, access: w.DWORD, sharing: w.DWORD, attributes: ?*w.SECURITY_ATTRIBUTES, creation: w.DWORD, flags: w.DWORD, template: ?w.HANDLE) callconv(.winapi) w.HANDLE;
pub extern "kernel32" fn CreatePseudoConsole(size: w.COORD, input: w.HANDLE, output: w.HANDLE, flags: w.DWORD, console: *w.HANDLE) callconv(.winapi) i32;
pub extern "kernel32" fn ResizePseudoConsole(console: w.HANDLE, size: w.COORD) callconv(.winapi) i32;
pub extern "kernel32" fn ClosePseudoConsole(console: w.HANDLE) callconv(.winapi) void;
pub extern "kernel32" fn InitializeProcThreadAttributeList(attributes: ?*anyopaque, count: w.DWORD, flags: w.DWORD, bytes: *usize) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn UpdateProcThreadAttribute(attributes: *anyopaque, flags: w.DWORD, attribute: usize, value: *anyopaque, size: usize, previous: ?*anyopaque, returned_size: ?*usize) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn DeleteProcThreadAttributeList(attributes: *anyopaque) callconv(.winapi) void;
pub extern "kernel32" fn CreateJobObjectW(attributes: ?*w.SECURITY_ATTRIBUTES, name: ?[*:0]const u16) callconv(.winapi) ?w.HANDLE;
pub extern "kernel32" fn SetInformationJobObject(job: w.HANDLE, class: c_int, information: *const anyopaque, length: w.DWORD) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn AssignProcessToJobObject(job: w.HANDLE, process: w.HANDLE) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn TerminateJobObject(job: w.HANDLE, code: w.UINT) callconv(.winapi) w.BOOL;
pub extern "kernel32" fn ResumeThread(thread: w.HANDLE) callconv(.winapi) w.DWORD;
