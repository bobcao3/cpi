# Editor tools

Four tools edit files: `write` creates a new file, `apply_patch` applies
unified-diff hunks to one existing file, `edit` delegates a natural-language
change to an editor subagent, and `read` returns full files or AI-filtered line
ranges. `edit` and `write` share per-path locking; `apply_patch` reports partial
applications and never creates, deletes, or renames files.

Model selection, fuzzy matching, correction turns, size limits, and the
availability chain are configured under `editor` in
[`cpi-config.default.json`](../packages/harness/cpi-config.default.json).
Tool contracts are the authority in
[`llm-editor.toml`](../packages/harness/src/text/llm-editor.toml).
Reads and writes over the configured size limit refuse with a `sh` workaround
instead of truncating.
