const std = @import("std");

pub fn command_line(allocator: std.mem.Allocator, argv: []const []const u8) ![:0]u16 {
    var command: std.ArrayList(u16) = .empty;
    for (argv, 0..) |arg, index| {
        if (index != 0) try command.append(allocator, ' ');
        try command.append(allocator, '"');
        const wide = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, arg);
        var cursor: usize = 0;
        while (cursor < wide.len) {
            var slashes: usize = 0;
            while (cursor < wide.len and wide[cursor] == '\\') : (cursor += 1) slashes += 1;
            const escapes = cursor == wide.len or wide[cursor] == '"';
            try command.appendNTimes(allocator, '\\', if (escapes) slashes * 2 else slashes);
            if (cursor == wide.len) break;
            if (wide[cursor] == '"') try command.append(allocator, '\\');
            try command.append(allocator, wide[cursor]);
            cursor += 1;
        }
        try command.append(allocator, '"');
        if (command.items.len >= 32767) return error.InvalidArguments;
    }
    return command.toOwnedSliceSentinel(allocator, 0);
}

pub fn environment(allocator: std.mem.Allocator, entries: []const []const u8) !std.process.Environ.Map {
    var map = try environment_exact(allocator, entries);
    errdefer map.deinit();
    try map.put("TERM", "xterm-256color");
    try map.put("COLORTERM", "truecolor");
    try map.put("TERM_PROGRAM", "ghostmux");
    return map;
}

pub fn environment_exact(allocator: std.mem.Allocator, entries: []const []const u8) !std.process.Environ.Map {
    var map: std.process.Environ.Map = .init(allocator);
    errdefer map.deinit();
    for (entries) |entry| {
        const equal = std.mem.indexOfScalar(u8, entry, '=').?;
        const name = entry[0..equal];
        if (!std.process.Environ.Map.validateKeyForPut(name)) return error.InvalidEnvironment;
        if (map.contains(name)) return error.InvalidEnvironment;
        try map.put(name, entry[equal + 1 ..]);
    }
    return map;
}

pub fn executable(allocator: std.mem.Allocator, io: std.Io, cwd: []const u8, command: []const u8, path: []const u8) ![:0]u16 {
    if (std.mem.indexOfAny(u8, command, "\\/:") != null) {
        const name = if (std.fs.path.isAbsolute(command)) command else try std.fs.path.join(allocator, &.{ cwd, command });
        return executable_name(allocator, name);
    }
    var parts = std.mem.splitScalar(u8, path, ';');
    var attempts: usize = 0;
    while (parts.next()) |part_raw| {
        attempts += 1;
        if (attempts > 1024) return error.InvalidEnvironment;
        const part = std.mem.trim(u8, part_raw, "\"");
        const directory = if (part.len == 0) cwd else if (std.fs.path.isAbsolute(part)) part else try std.fs.path.join(allocator, &.{ cwd, part });
        const candidate = try std.fs.path.join(allocator, &.{ directory, command });
        const name = if (std.fs.path.extension(command).len == 0) try std.mem.concat(allocator, u8, &.{ candidate, ".exe" }) else candidate;
        if (name.len > 32767) continue;
        const stat = std.Io.Dir.cwd().statFile(io, name, .{}) catch continue;
        if (stat.kind == .file) return std.unicode.wtf8ToWtf16LeAllocZ(allocator, name);
    }
    return error.ExecutableNotFound;
}

fn executable_name(allocator: std.mem.Allocator, name: []const u8) ![:0]u16 {
    const extended = if (std.fs.path.extension(name).len == 0) try std.mem.concat(allocator, u8, &.{ name, ".exe" }) else name;
    if (extended.len > 32767) return error.InvalidArguments;
    return std.unicode.wtf8ToWtf16LeAllocZ(allocator, extended);
}
