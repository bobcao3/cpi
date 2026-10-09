# Storage

cpi keeps state in user-scoped directories, all owner-only (0700 directories,
0600 files). The contract is:

- **Agent directory.** `getAgentDir()` resolves the harness directory holding
  configuration, caches, environment captures, LSP logs, and editor transcripts.
- **Sessions.** The host CLI names the session directory in `PI_SESSION_DIR`;
  transcripts, shell records, and per-session state live there, and that
  directory is what session resume reads.
- **Runtime sockets.** `resolveRuntimeDir()` picks the first writable runtime
  directory: `$XDG_RUNTIME_DIR/cpi`, then `$PI_SESSION_DIR/runtime`, then
  `~/.cpi/runtime` (POSIX only).
- **Shell sessions.** [Ghostmux](../packages/ghostmux/README.md) keeps each
  running shell's socket and log under its session directories; the log path is
  returned with every `sh` result.

Resolve paths from these variables rather than copying examples. The
authorities are
[`runtime-dir.ts`](../packages/harness/src/lib/runtime-dir.ts),
[`config.ts`](../packages/harness/src/lib/config.ts), and the Pi
`getAgentDir` implementation in the pinned artifacts.
