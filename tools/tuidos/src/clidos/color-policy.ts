// Decide color policy BEFORE any module that caches color support is imported.
// citty/consola only honors NO_COLOR (not isatty) and caches at import time, so
// this side-effect import must be the very first one (ESM evaluates a module's
// imports in source order). When stdout isn't a TTY and the user hasn't forced
// color, disable color process-wide: picocolors then reports isColorSupported=
// false and our renderers switch to markdown; citty's usage/--help strip their
// ANSI instead of leaking raw escapes into piped output. (AGENTS.md: non-TTY is
// still beautiful — *emphasis*, # section, > note.)
if (!process.stdout.isTTY && !process.env.FORCE_COLOR) process.env.NO_COLOR = "1";
