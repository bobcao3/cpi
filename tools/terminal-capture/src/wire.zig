const std = @import("std");
pub const protocol_version = 1;
pub const max_request = 1024 * 1024;
pub const max_response = 8 * 1024 * 1024;
pub const max_clients = 16;
pub const max_sessions = 16;
pub const timeout_ms = 10000;

pub const Operation = enum { new_session, list_sessions, capture_pane, screenshot, send_input, resize_window, kill_session, kill_server };
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
    font_size: u16 = 18,
    base64: ?[]const u8 = null,
};
pub const Status = struct { uid: []const u8, pid: i32, cols: u16, rows: u16, bytes: u64, exit_code: ?i32 };
pub const Response = struct {
    version: u32 = protocol_version,
    ok: bool = true,
    error_name: ?[]const u8 = null,
    server_pid: i32,
    session: ?Status = null,
    sessions: ?[]const Status = null,
    text: ?[]const u8 = null,
    path: ?[]const u8 = null,
};

pub fn validate_uid(uid: []const u8) !void {
    if (uid.len == 0 or uid.len > 128) return error.InvalidUid;
    for (uid) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "_.:-", byte) == null) return error.InvalidUid;
    }
}
