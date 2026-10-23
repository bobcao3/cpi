const std = @import("std");
const Dir = std.Io.Dir;
const tree = @import("guardian_tree.zig");
const security = @import("runtime_security.zig");
pub const State = enum { pending, closed, retained };
pub const Evidence = enum { none, controller_close, pidfd_exit };
pub const Request = struct {
    version: u32,
    host_pid: i32,
    session_id: []const u8,
    session_dir: []const u8,
    root: []const u8,
    journal: []const u8,
    id: []const u8,
    retain: bool,
};
pub const Record = struct {
    version: u32 = 1,
    owner_uid: u32,
    guardian_pid: i32,
    host_pid: i32,
    session_id: []const u8,
    session_dir: []const u8,
    root: []const u8,
    journal: []const u8,
    id: []const u8,
    path: []const u8,
    identity: ?tree.Identity = null,
    scope_removed: bool = false,
    root_identity: tree.Identity,
    retain: bool,
    state: State = .pending,
    host_closed: bool = false,
    closure_evidence: Evidence = .none,
    error_name: ?[]const u8 = null,
};

pub fn valid_id(id: []const u8) bool {
    if (id.len != 36) return false;
    for (id, 0..) |byte, index| {
        if (index == 8 or index == 13 or index == 18 or index == 23) {
            if (byte != '-') return false;
        } else if (!std.ascii.isHex(byte)) return false;
    }
    return true;
}

pub fn basename(allocator: std.mem.Allocator, id: []const u8, retain: bool) ![]const u8 {
    if (!valid_id(id)) return error.InvalidId;
    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ if (retain) "retained" else "scratch", id });
}

pub fn filename(allocator: std.mem.Allocator, id: []const u8) ![]const u8 {
    if (!valid_id(id)) return error.InvalidId;
    return std.fmt.allocPrint(allocator, "{s}.json", .{id});
}

pub fn lock(allocator: std.mem.Allocator, io: std.Io, journal: Dir, id: []const u8) !std.Io.File {
    if (!valid_id(id)) return error.InvalidId;
    const name = try std.fmt.allocPrint(allocator, "{s}.lock", .{id});
    defer allocator.free(name);
    const file = journal.createFile(io, name, .{ .exclusive = true, .permissions = .fromMode(0o600) }) catch |err| switch (err) {
        error.PathAlreadyExists => try journal.openFile(io, name, .{ .mode = .read_write, .follow_symlinks = false }),
        else => return err,
    };
    errdefer file.close(io);
    const stat = try file.stat(io);
    const named = try journal.statFile(io, name, .{ .follow_symlinks = false });
    if (stat.kind != .file or named.kind != .file or stat.inode != named.inode or stat.nlink != 1 or stat.permissions.toMode() & 0o077 != 0 or try security.file_owner(file) != security.uid()) return error.UnsafeLock;
    if (!try file.tryLock(io, .exclusive)) return error.RecordBusy;
    return file;
}

pub fn save(allocator: std.mem.Allocator, io: std.Io, journal: Dir, record: Record, initial: bool) !void {
    var current = try tree.private_dir(allocator, io, record.journal);
    defer current.close(io);
    if (!(try tree.identity(current)).eql(try tree.identity(journal))) return error.JournalIdentityMismatch;
    var bytes: [32768]u8 = undefined;
    var writer = std.Io.Writer.fixed(&bytes);
    try std.json.Stringify.value(record, .{}, &writer);
    try writer.writeByte('\n');
    const name = try filename(allocator, record.id);
    defer allocator.free(name);
    var random: [16]u8 = undefined;
    try io.randomSecure(&random);
    const temporary = try std.fmt.allocPrint(allocator, ".{s}.tmp", .{std.fmt.bytesToHex(random, .lower)});
    defer allocator.free(temporary);
    const output = if (initial) name else temporary;
    const file = try journal.createFile(io, output, .{ .exclusive = true, .permissions = .fromMode(0o600) });
    defer file.close(io);
    defer if (!initial) journal.deleteFile(io, temporary) catch {};
    try file.writeStreamingAll(io, writer.buffered());
    try file.sync(io);
    if (!initial) try journal.rename(temporary, journal, name, io);
    try tree.sync(journal, io);
}

pub fn finish(allocator: std.mem.Allocator, io: std.Io, root: Dir, journal: Dir, record: *Record) !void {
    if (record.closure_evidence == .none or (record.closure_evidence == .pidfd_exit and !record.host_closed)) return error.ClosureUnproven;
    record.state = .pending;
    record.error_name = null;
    try save(allocator, io, journal, record.*, false);
    if (record.retain) {
        record.state = .retained;
    } else {
        if (!record.scope_removed) {
            cleanup(allocator, io, root, record.*) catch |err| {
                record.error_name = @errorName(err);
                try save(allocator, io, journal, record.*, false);
                return err;
            };
            record.scope_removed = true;
        }
        record.state = .closed;
    }
    save(allocator, io, journal, record.*, false) catch |err| {
        record.state = .pending;
        record.error_name = @errorName(err);
        return err;
    };
}

fn cleanup(allocator: std.mem.Allocator, io: std.Io, root: Dir, record: Record) !void {
    const expected = record.identity orelse return error.MissingIdentity;
    var current = try tree.private_dir(allocator, io, record.root);
    defer current.close(io);
    if (!record.root_identity.eql(try tree.identity(current)) or !record.root_identity.eql(try tree.identity(root))) return error.RootIdentityMismatch;
    const name = try basename(allocator, record.id, record.retain);
    defer allocator.free(name);
    const expected_path = try std.fs.path.join(allocator, &.{ record.root, name });
    defer allocator.free(expected_path);
    if (!std.mem.eql(u8, record.path, expected_path)) return error.InvalidScopePath;
    try tree.remove(io, root, name, expected);
}

pub fn reconcile(allocator: std.mem.Allocator, io: std.Io, root: Dir, journal: Dir, request: Request) !void {
    var iterator = journal.iterate();
    var count: usize = 0;
    while (try iterator.next(io)) |entry| {
        count += 1;
        if (count > 4096) return error.JournalScanLimit;
        if (entry.kind != .file or entry.name.len != 41 or !std.mem.endsWith(u8, entry.name, ".json") or !valid_id(entry.name[0..36])) continue;
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const local = arena.allocator();
        const held = lock(local, io, journal, entry.name[0..36]) catch continue;
        defer held.close(io);
        const file = journal.openFile(io, entry.name, .{ .follow_symlinks = false }) catch continue;
        defer file.close(io);
        const stat = try file.stat(io);
        if (stat.kind != .file or stat.size > 32768 or stat.permissions.toMode() & 0o077 != 0 or try security.file_owner(file) != security.uid()) continue;
        var bytes: [32769]u8 = undefined;
        var length: usize = 0;
        while (length < bytes.len) {
            const n = file.readStreaming(io, &.{bytes[length..]}) catch |err| switch (err) {
                error.EndOfStream => break,
                else => return err,
            };
            if (n == 0) break;
            length += n;
        }
        if (length > 32768) continue;
        const parsed = std.json.parseFromSlice(Record, local, bytes[0..length], .{}) catch continue;
        var record = parsed.value;
        if (record.version != 1 or record.owner_uid != security.uid() or !std.mem.eql(u8, record.id, entry.name[0..36]) or !std.mem.eql(u8, record.root, request.root) or !std.mem.eql(u8, record.journal, request.journal)) continue;
        if (record.state != .pending or record.closure_evidence != .pidfd_exit or !record.host_closed) continue;
        finish(local, io, root, journal, &record) catch {};
    }
}
