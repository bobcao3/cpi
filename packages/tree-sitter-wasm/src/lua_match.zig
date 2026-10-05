//! Minimal Lua-pattern matcher used to evaluate `#lua-match?` predicates from
//! the bash highlight query.
//!
//! Implements the common subset: `%class` (a d s w l u p c x and uppercase
//! complements, plus `%` literal escape), `[set]` with ranges and `^`
//! complement, `.` any byte, `* + - ?` quantifiers, `^` start anchor, `$` end
//! anchor. No captures — boolean match only (sufficient for predicates).
//!
//! Mirrors PUC-Rio Lua's byte-oriented `lstrlib.c` match algorithm. Inputs are
//! tiny (capture text + a short pattern); recursion depth is bounded by pattern
//! length.

const std = @import("std");

/// True if `pattern` matches anywhere in `text` (Lua `string.match` semantics).
/// A leading `^` anchors the match to the start of `text`.
pub fn luaMatch(text: []const u8, pattern: []const u8) bool {
    if (pattern.len == 0) return true;
    const anchored = pattern[0] == '^';
    const start: usize = if (anchored) 1 else 0;
    var s: usize = 0;
    while (true) {
        if (match(text, s, pattern, start) != null) return true;
        if (anchored) return false;
        if (s >= text.len) return false;
        s += 1;
    }
}

fn match(text: []const u8, s: usize, pat: []const u8, pi: usize) ?usize {
    var sp = s;
    var pp = pi;
    while (true) {
        if (pp >= pat.len) return sp; // pattern exhausted → match
        const item = pat[pp];
        if (item == '$' and pp + 1 == pat.len) return if (sp == text.len) sp else null;
        const il = itemLen(pat, pp);
        const next: u8 = if (pp + il < pat.len) pat[pp + il] else 0;
        if (next == '*') {
            return maxExpand(text, sp, pat, pp, il);
        } else if (next == '+') {
            if (matchItem(text, sp, pat, pp) == null) return null;
            return maxExpand(text, sp + 1, pat, pp, il);
        } else if (next == '-') {
            return minExpand(text, sp, pat, pp, il);
        } else if (next == '?') {
            if (matchItem(text, sp, pat, pp) != null) {
                if (match(text, sp + 1, pat, pp + il + 1)) |r| return r;
            }
            pp += il + 1; // skip item + '?', try without it
        } else {
            if (matchItem(text, sp, pat, pp)) |ns| {
                sp = ns;
                pp += il;
            } else return null;
        }
    }
}

/// Greedy `*` / `+`: take as many matching items as possible, then backtrack
/// down to zero (for `*`) or one (caller pre-consumed one for `+`).
fn maxExpand(text: []const u8, s: usize, pat: []const u8, pi: usize, il: usize) ?usize {
    var i: usize = 0;
    while (s + i < text.len and matchItem(text, s + i, pat, pi) != null) : (i += 1) {}
    while (true) : (i -= 1) {
        if (match(text, s + i, pat, pi + il + 1)) |r| return r;
        if (i == 0) return null;
    }
}

/// Lazy `-`: try zero reps first, then grow until the item stops matching.
fn minExpand(text: []const u8, s: usize, pat: []const u8, pi: usize, il: usize) ?usize {
    var k: usize = 0;
    while (true) : (k += 1) {
        if (match(text, s + k, pat, pi + il + 1)) |r| return r;
        if (matchItem(text, s + k, pat, pi) == null) return null;
    }
}

/// If the byte at `text[s]` matches the pattern item at `pat[pi]`, return
/// `s + 1`; otherwise null. Does not advance the pattern index.
fn matchItem(text: []const u8, s: usize, pat: []const u8, pi: usize) ?usize {
    if (s >= text.len) return null;
    const ch = text[s];
    const item = pat[pi];
    if (item == '.') return s + 1;
    if (item == '%') {
        if (pi + 1 >= pat.len) return if (ch == '%') s + 1 else null;
        return if (classMatch(pat[pi + 1], ch)) s + 1 else null;
    }
    if (item == '[') return if (setMatch(pat, pi, ch)) s + 1 else null;
    return if (ch == item) s + 1 else null;
}

/// Byte length of the pattern item at `pat[pi]`.
fn itemLen(pat: []const u8, pi: usize) usize {
    const item = pat[pi];
    if (item == '%') return 2;
    if (item == '[') {
        var j = pi + 1;
        if (j < pat.len and pat[j] == '^') j += 1;
        if (j < pat.len and pat[j] == ']') j += 1; // ']' as first member
        while (j < pat.len and pat[j] != ']') : (j += 1) {
            if (pat[j] == '%' and j + 1 < pat.len) j += 1;
        }
        return j - pi + 1; // include closing ']'
    }
    return 1;
}

/// `%x` class test. Uppercase letter = complement of the lowercase class.
fn classMatch(cls: u8, ch: u8) bool {
    const lower = std.ascii.toLower(cls);
    const pos = switch (lower) {
        'a' => std.ascii.isAlphabetic(ch),
        'd' => std.ascii.isDigit(ch),
        's' => std.ascii.isWhitespace(ch),
        'w' => std.ascii.isAlphanumeric(ch),
        'l' => std.ascii.isLower(ch),
        'u' => std.ascii.isUpper(ch),
        'p' => std.ascii.isPrint(ch) and !std.ascii.isAlphanumeric(ch) and !std.ascii.isWhitespace(ch),
        'c' => std.ascii.isControl(ch),
        'x' => std.ascii.isHex(ch),
        else => return ch == cls, // `%<other>` = literal <other>
    };
    return if (std.ascii.isUpper(cls)) !pos else pos;
}

/// `[...]` set test (handles `^` complement, ranges `a-b`, `%class`).
fn setMatch(pat: []const u8, pi: usize, ch: u8) bool {
    var j = pi + 1;
    var negate = false;
    if (j < pat.len and pat[j] == '^') {
        negate = true;
        j += 1;
    }
    var found = false;
    while (j < pat.len and pat[j] != ']') {
        if (pat[j] == '%' and j + 1 < pat.len) {
            if (classMatch(pat[j + 1], ch)) found = true;
            j += 2;
        } else if (j + 2 < pat.len and pat[j + 1] == '-' and pat[j + 2] != ']') {
            if (ch >= pat[j] and ch <= pat[j + 2]) found = true;
            j += 3;
        } else {
            if (ch == pat[j]) found = true;
            j += 1;
        }
    }
    return if (negate) !found else found;
}
