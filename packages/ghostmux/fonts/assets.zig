const std = @import("std");

pub const Face = enum { mono, mono_bold, cjk, cjk_bold, emoji, icons };
pub const data = std.EnumArray(Face, []const u8).init(.{
    .mono = @embedFile("NotoSansMono-Regular.ttf"),
    .mono_bold = @embedFile("NotoSansMono-Bold.ttf"),
    .cjk = @embedFile("NotoSansMonoCJKsc-Regular.otf"),
    .cjk_bold = @embedFile("NotoSansMonoCJKsc-Bold.otf"),
    .emoji = @embedFile("NotoEmoji-Regular.ttf"),
    .icons = @embedFile("SymbolsNerdFontMono-Regular.ttf"),
});
