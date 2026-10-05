const std = @import("std");
const builtin = @import("builtin");
const windows = builtin.os.tag == .windows;
pub const Signal = if (windows) std.os.linux.SIG else std.posix.SIG;

pub fn parse(name: []const u8) !Signal {
    if (name.len == 0 or name.len > 32) return error.InvalidSignal;
    var text = name;
    const prefix = "SIG";
    if (text.len >= prefix.len and std.ascii.eqlIgnoreCase(text[0..prefix.len], prefix)) text = text[prefix.len..];
    if (text.len == 0) return error.InvalidSignal;
    if (text[0] >= '0' and text[0] <= '9') {
        for (text) |character| if (character < '0' or character > '9') return error.InvalidSignal;
        const number = std.fmt.parseInt(u32, text, 10) catch return error.InvalidSignal;
        if (!valid_number(number)) return error.InvalidSignal;
        return @enumFromInt(number);
    }
    inline for (@typeInfo(Signal).@"enum".fields) |field| {
        if (std.ascii.eqlIgnoreCase(text, field.name)) return @enumFromInt(field.value);
    }
    inline for (@typeInfo(Signal).@"enum".decls) |declaration| {
        const value = @field(Signal, declaration.name);
        if (@TypeOf(value) == Signal) {
            if (std.ascii.eqlIgnoreCase(text, declaration.name)) return value;
        }
    }
    if (windows and std.ascii.eqlIgnoreCase(text, "BREAK")) return .TERM;
    if (windows or builtin.os.tag == .linux) {
        if (std.ascii.eqlIgnoreCase(text, "RTMIN")) return @enumFromInt(realtime_min());
        if (std.ascii.eqlIgnoreCase(text, "RTMAX")) return @enumFromInt(std.os.linux.NSIG - 1);
    }
    return error.InvalidSignal;
}

fn valid_number(number: u32) bool {
    if (number == 0) return false;
    if (windows or builtin.os.tag == .linux) return number < std.os.linux.NSIG;
    inline for (@typeInfo(Signal).@"enum".fields) |field| {
        if (number == field.value) return true;
    }
    if (@hasDecl(Signal, "RTMIN") and @hasDecl(Signal, "RTMAX")) {
        return number >= Signal.RTMIN and number <= Signal.RTMAX;
    }
    return false;
}

fn realtime_min() u32 {
    return if (windows) 34 else std.c.sigrtmin();
}
