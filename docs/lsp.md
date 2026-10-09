# LSP sessions

The `lsp` tool manages language servers per project root:
`list_supported_servers`, `start file=<path>`, `list_sessions`,
`stop file=<path>`, and `check` for per-file diagnostics. `start` searches
upward for a project root and provisions the server when needed, reporting what
it installs.

Writes through `write`, `edit`, and `apply_patch` auto-start a session in the
discovered project root and surface diagnostics; without a running session,
`lsp check` has nothing to query. Zig matches zls to the project's Zig version
pin, so changing the pin needs `lsp stop` followed by `lsp start`.

Server choices, versions, and timeouts are configuration, not documentation:
see the `lsp` section of
[`cpi-config.default.json`](../packages/extensions/cpi-config.default.json).
Model-facing rules are the authority in
[`lsp.toml`](../packages/extensions/extensions/text/lsp.toml); the subsystem
design is in
[`DESIGN.md`](../packages/extensions/extensions/lib/lsp/DESIGN.md).
