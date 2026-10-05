const std = @import("std");
const w = std.os.windows;
const Allocator = std.mem.Allocator;
const Acl = extern struct { revision: u8, reserved: u8, size: u16, count: u16, reserved2: u16 };
const Ace = extern struct { kind: u8, flags: u8, size: u16 };
const TokenUser = extern struct { sid: *anyopaque, attributes: w.DWORD };
const token_query: w.DWORD = 0x0008;
const owner_information: w.DWORD = 1;
const dacl_information: w.DWORD = 4;

extern "advapi32" fn OpenProcessToken(process: w.HANDLE, access: w.DWORD, token: *w.HANDLE) callconv(.winapi) w.BOOL;
extern "advapi32" fn GetTokenInformation(token: w.HANDLE, class: c_int, data: ?*anyopaque, bytes: w.DWORD, needed: *w.DWORD) callconv(.winapi) w.BOOL;
extern "advapi32" fn ConvertSidToStringSidW(sid: *anyopaque, text: *[*:0]u16) callconv(.winapi) w.BOOL;
extern "advapi32" fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: [*:0]const u16, revision: w.DWORD, descriptor: **anyopaque, bytes: ?*w.DWORD) callconv(.winapi) w.BOOL;
extern "advapi32" fn GetNamedSecurityInfoW(path: [*:0]const u16, object: c_int, information: w.DWORD, owner: *?*anyopaque, group: ?*?*anyopaque, dacl: *?*Acl, sacl: ?*?*Acl, descriptor: **anyopaque) callconv(.winapi) w.DWORD;
extern "advapi32" fn EqualSid(first: *anyopaque, second: *anyopaque) callconv(.winapi) w.BOOL;
extern "advapi32" fn IsValidAcl(acl: *Acl) callconv(.winapi) w.BOOL;
extern "advapi32" fn GetAce(acl: *Acl, index: w.DWORD, ace: **anyopaque) callconv(.winapi) w.BOOL;
extern "advapi32" fn IsWellKnownSid(sid: *anyopaque, kind: c_int) callconv(.winapi) w.BOOL;
extern "kernel32" fn LocalFree(memory: *anyopaque) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn CreateDirectoryW(path: [*:0]const u16, attributes: *w.SECURITY_ATTRIBUTES) callconv(.winapi) w.BOOL;

const Identity = struct {
    bytes: []align(@alignOf(TokenUser)) u8,
    allocator: Allocator,

    fn init(allocator: Allocator) !Identity {
        var token: w.HANDLE = undefined;
        if (OpenProcessToken(w.GetCurrentProcess(), token_query, &token) == .FALSE) return error.TokenOpenFailed;
        defer w.CloseHandle(token);
        var needed: w.DWORD = 0;
        _ = GetTokenInformation(token, 1, null, 0, &needed);
        if (needed < @sizeOf(TokenUser) or needed > 64 * 1024) return error.TokenInformationFailed;
        const bytes = try allocator.alignedAlloc(u8, .of(TokenUser), needed);
        errdefer allocator.free(bytes);
        if (GetTokenInformation(token, 1, bytes.ptr, needed, &needed) == .FALSE) return error.TokenInformationFailed;
        return .{ .bytes = bytes, .allocator = allocator };
    }

    fn sid(self: Identity) *anyopaque {
        const user: *const TokenUser = @ptrCast(self.bytes.ptr);
        return user.sid;
    }

    fn deinit(self: Identity) void {
        self.allocator.free(self.bytes);
    }
};

pub fn check(allocator: Allocator, path: []const u8) !void {
    const wide = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, path);
    defer allocator.free(wide);
    const identity = try Identity.init(allocator);
    defer identity.deinit();
    var owner: ?*anyopaque = null;
    var acl: ?*Acl = null;
    var descriptor: *anyopaque = undefined;
    if (GetNamedSecurityInfoW(wide, 1, owner_information | dacl_information, &owner, null, &acl, null, &descriptor) != 0) return error.SecurityInformationFailed;
    defer _ = LocalFree(descriptor);
    if (owner == null or EqualSid(owner.?, identity.sid()) == .FALSE) return error.UnsafeSocketDirectory;
    const list = acl orelse return error.UnsafeSocketDirectory;
    if (IsValidAcl(list) == .FALSE or list.count == 0 or list.count > 128) return error.UnsafeSocketDirectory;
    for (0..list.count) |index| {
        var entry: *anyopaque = undefined;
        if (GetAce(list, @intCast(index), &entry) == .FALSE) return error.UnsafeSocketDirectory;
        const header: *const Ace = @ptrCast(@alignCast(entry));
        if (header.kind == 1) continue;
        if (header.kind != 0 or header.size < 16) return error.UnsafeSocketDirectory;
        const bytes: [*]u8 = @ptrCast(entry);
        const sid: *anyopaque = bytes + 8;
        if (EqualSid(sid, identity.sid()) == .FALSE and IsWellKnownSid(sid, 22) == .FALSE) return error.UnsafeSocketDirectory;
    }
}

pub fn create(allocator: Allocator, path: []const u8) !void {
    const identity = try Identity.init(allocator);
    defer identity.deinit();
    var sid_text: [*:0]u16 = undefined;
    if (ConvertSidToStringSidW(identity.sid(), &sid_text) == .FALSE) return error.SidConversionFailed;
    defer _ = LocalFree(sid_text);
    const sid_utf8 = try std.unicode.utf16LeToUtf8Alloc(allocator, std.mem.span(sid_text));
    defer allocator.free(sid_utf8);
    const sddl = try std.fmt.allocPrint(allocator, "O:{s}D:P(A;OICI;FA;;;{s})(A;OICI;FA;;;SY)", .{ sid_utf8, sid_utf8 });
    defer allocator.free(sddl);
    const sddl_wide = try std.unicode.utf8ToUtf16LeAllocZ(allocator, sddl);
    defer allocator.free(sddl_wide);
    var descriptor: *anyopaque = undefined;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide, 1, &descriptor, null) == .FALSE) return error.SecurityDescriptorFailed;
    defer _ = LocalFree(descriptor);
    const wide = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, path);
    defer allocator.free(wide);
    var attributes: w.SECURITY_ATTRIBUTES = .{ .nLength = @sizeOf(w.SECURITY_ATTRIBUTES), .lpSecurityDescriptor = descriptor, .bInheritHandle = .FALSE };
    if (CreateDirectoryW(wide, &attributes) == .FALSE and w.GetLastError() != .ALREADY_EXISTS) return error.DirectoryCreateFailed;
    try check(allocator, path);
}

pub fn is_socket(io: std.Io, path: []const u8) !bool {
    const file = try std.Io.Dir.cwd().openFile(io, path, .{ .follow_symlinks = false });
    defer file.close(io);
    var status: w.IO_STATUS_BLOCK = undefined;
    var information: w.FILE.ATTRIBUTE_TAG_INFO = undefined;
    const result = w.ntdll.NtQueryInformationFile(file.handle, &status, &information, @sizeOf(w.FILE.ATTRIBUTE_TAG_INFO), .AttributeTag);
    if (result != .SUCCESS) return error.SocketStatFailed;
    return @as(u32, @bitCast(information.ReparseTag)) == @as(u32, @bitCast(w.IO_REPARSE_TAG.AF_UNIX));
}
