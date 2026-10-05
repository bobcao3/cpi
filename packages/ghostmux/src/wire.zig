const std = @import("std");
pub const protocol_version = 1;
pub const max_request = 1024 * 1024;
pub const max_response = 8 * 1024 * 1024;
pub const max_output_chunk = 64 * 1024;
pub const timeout_ms = 10000;

pub fn process_id() i32 {
    return if (@import("builtin").os.tag == .windows)
        @intCast(@intFromPtr(std.os.windows.teb().ClientId.UniqueProcess))
    else
        @intCast(std.posix.system.getpid());
}

pub const Operation = enum { new_session, list_sessions, capture_pane, screenshot, send_input, resize_window, kill_session, kill_server, read_output, subscribe_output, signal_session };
pub const Request = struct {
    version: u32 = protocol_version,
    op: Operation,
    uid: ?[]const u8 = null,
    argv: []const []const u8 = &.{},
    env: []const []const u8 = &.{},
    cwd: ?[]const u8 = null,
    cols: u16 = 80,
    rows: u16 = 24,
    history: bool = false,
    join: bool = false,
    path: ?[]const u8 = null,
    font_size: u16 = (@import("options.zig").Options{}).font_size,
    base64: ?[]const u8 = null,
    log_path: ?[]const u8 = null,
    status_path: ?[]const u8 = null,
    subscribe: bool = false,
    is_pty: bool = true,
    signal: ?[]const u8 = null,
    offset: u64 = 0,
    limit: u32 = max_output_chunk,
};
pub const Status = struct { uid: []const u8, pid: i32, cols: u16, rows: u16, bytes: u64, exit_code: ?i32, is_pty: bool };
pub const Response = struct {
    version: u32 = protocol_version,
    ok: bool = true,
    error_name: ?[]const u8 = null,
    server_pid: i32,
    session: ?Status = null,
    sessions: ?[]const Status = null,
    text: ?[]const u8 = null,
    path: ?[]const u8 = null,
    event: ?[]const u8 = null,
    uid: ?[]const u8 = null,
    offset: ?u64 = null,
    next_offset: ?u64 = null,
    base64: ?[]const u8 = null,
    eof: bool = false,
};

pub fn validate_uid(uid: []const u8) !void {
    if (uid.len == 0 or uid.len > 128) return error.InvalidUid;
    for (uid) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "_.:-", byte) == null) return error.InvalidUid;
    }
}
