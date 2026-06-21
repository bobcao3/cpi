# cpi LSP subsystem — implementation action items

Companion to `docs/lsp-design.md`. Five JJ **change layers**, each independently
buildable and self-verifying, stacked in dependency order. One layer per `jj`
change; `jj split` if a change picks up unrelated edits.

**Layer 1 is decoupled from LSP entirely** — dotenv + `env=` on the shell tools +
`sh_env_capture`. Done first because the LSP subsystem only *consumes* these
(`lsp env=`, `sh_env_capture`→restart). It can land and be verified with no LSP
code present.

All files ≤ 397 src lines / 355 AST. Pure-leaf modules import no pi/ExtensionAPI.
Only owners (`lsp.ts`, `env-capture.ts`) import `ExtensionAPI`.

Legend: **DO** · **VERIFY** (real-world, before next layer) · **GATE** (must pass
inside the layer before relying on it).

**Path decision (supersedes design §5/§6.4):** `parseDotEnv` lives at
`extensions/lib/dotenv.ts` (neutral), **not** `lib/lsp/dotenv.ts`. It is a general
util, lands before any `lib/lsp/` file exists, and is consumed by both the shell
tools (Layer 1) and the LSP subsystem (Layers 2+). The LSP modules import it from
the neutral path.

---

## Pre-flight risks (resolve with the layer noted)

- **R1 `buildOutputText` path (Layer 2).** Design §6.5/§7.4 claims a pi-package
  re-export. False — grep of pi dist empty; it lives in `extensions/shell/exec.ts`.
  cpi can't edit installed pi. **Decision:** extract a pure truncator into
  `extensions/lib/output-truncate.ts`, re-import from `shell/exec.ts`, import
  from `lib/lsp/manager.ts`.
- **R2 `shell.ts` budget (Layers 1 + 5).** 424 raw lines; design claims 396/397
  *src*. Measure real src/AST before Layer 1 (env= touches it) and re-measure at
  Layer 5. If headroom < ~6 src lines, extraction (`lsp-hook.ts`,
  `buildShellEnvWithDotenv`) is mandatory, not optional.
- **R3 `repeat.ts` budget + lint coupling (Layer 1).** 337 raw lines, imports
  `lintCommand`/`formatDiagnostics` from `lint.ts`. Layer 1 rewires env build +
  ctx usage; confirm AST headroom. (Layer 3 rewrite must preserve those
  signatures or `repeat.ts` breaks.)
- **R4 uv verification (Layer 2).** GitHub Artifact Attestation primary
  (`gh attestation verify --repo astral-sh/uv`), sha256 fallback when `gh`
  absent. Never minisign for uv (`lib/minisig.ts` stays tree-sitter-wasm-only).
  Pin exact asset name for `tools.uv.version`.
- **R5 `globalThis.__cpiLsp` (Layer 2).** Slot free — re-grep `globalThis.__cpi`.

---

## Layer 1 — dotenv + shell `env=` + `sh_env_capture`  *(no LSP dependency)*

**DO:**
- `extensions/lib/dotenv.ts` — `parseDotEnv(path): Record<string,string>`. Bounded:
  256 KiB file, 4096 keys, 32 KiB value; no `${}` interpolation; strip `export `
  prefix + surrounding `"`/`'`. Pure node, no pi import. Shared by `sh`/`lsp`/
  `sh_repeat_until` env=, server spawn env, and `sh_env_capture` (write side plain `KEY=VALUE`).
- `extensions/shell/tools.ts` — `buildShellEnvWithDotenv(sm, envPath?)` =
  `buildShellEnv(sm)` then merge `parseDotEnv(resolveCwdPath(envPath))`. Merge
  order: process env ← tool PATH bins ← `PI_SESSION*` ← dotenv wins. Pure leaf.
- `extensions/shell.ts` — `env?: path` on `sh` schema; in `execute` swap env build
  to `buildShellEnvWithDotenv(ctx?.sessionManager, params.env)`. **Not inlined**
  beyond the one-liner call (R2). +1 guideline line: "Editing commands trigger
  LSP auto-lint when a session is up; else run `lsp start`." (Prospective — LSP
  arrives Layer 4.)
- `extensions/shell/repeat.ts` — `env?: path` on schema; rewire env from bare
  `getToolEnv()` to `buildShellEnvWithDotenv(ctx?.sessionManager, env)`; stop
  typing ctx `_ctx` (now used); `startRepeat` receives merged env (R3).
- `extensions/env-capture.ts` — sole owner of `sh_env_capture` (schema
  `command?`/`label?`). Runs `bash -lc '<cmd> && env'` (or bare `env`) inheriting
  `buildShellEnv`; writes `KEY=VALUE` to
  `<sessionDir>/env-captures/<label-or-shortSha>.env` (fallback
  `getAgentDir()/env-captures/` for `--no-session` parents; `mkdir -p`).
  Limits 4096 keys / 32 KiB value truncation on write. Returns path + count +
  ready `env=<path>` snippet. No echo of env into conversation. `promptGuidelines`
  describe capture→reload via `env=` on `sh`/`sh_repeat_until` (lsp reload line
  added in Layer 4 once `lsp` exists).

**VERIFY:**
- `parseDotEnv` round-trips a sample `.env` (quotes, `export `, `#` comments,
  blanks, `=`-in-value); rejects over-limit file gracefully.
- `sh env=<path>` exporting `FOO=bar` → command sees `FOO`; dotenv wins over
  process env on conflict; missing file → clear error, no crash.
- `sh_repeat_until env=<path>` → repeated cmd sees dotenv vars + `PI_SESSION*`/
  `PI_SESSION_DIR`.
- `sh_env_capture command="source .venv/bin/activate"` → `.env` has venv
  `VIRTUAL_ENV`/`PATH`; reload via `sh env=<path>` sees them. No-command capture
  → current process env snapshot. Ephemeral `--no-session` parent → file in
  `getAgentDir()/env-captures/`. Path returned absolute + reusable.
- `shell.ts` + `repeat.ts` re-measured ≤ limit (R2/R3).

---

## Layer 2 — LSP foundation: config + pure leaves + truncator

No behavior change, no tool, no producer touched.

**DO:**
- `extensions/lib/output-truncate.ts` — extract `buildOutputText` + tunables (R1);
  `shell/exec.ts` re-imports from here.
- `extensions/lib/lsp/diagnostics.ts` — `Diagnostic` + `formatDiagnostics`.
- `extensions/lib/lsp/discover.ts` — `discoverProjectRoot(startPath, langHint?)`
  + `languageByPath(path)`. Depth cap 32, stop at `HOME`/`/`. Marker priority per
  §6.1. Lone file → `dirname` fallback root.
- `extensions/lib/config.ts` — `LspConfig` + `loadLspConfig(cwd)` (deep-merge,
  clamp via existing `intInRange`).
- `cpi-config.default.json` — `lsp` section (§12).
- `extensions/lib/lsp/registry.ts` — `LspServerSpec` per language (typescript
  npm / python uv-pyrefly / shell reuse-shuck), reads pins via `loadLspConfig`.
  Python `fullCheckCommand` runs `pyrefly check` with `cwd=root`, **not**
  `pyrefly check <root>`.

**VERIFY:** node one-shot against this repo + scratch `.py`/`.sh`: `discoverProjectRoot`
finds cpi root via `.git` + lone-file fallback; `languageByPath` maps
`.ts/.tsx`(`.tsx`→`typescriptreact`)/`.py/.sh/.bash`; `loadLspConfig` clamps +
exact pins. `shell/exec.ts` still builds (truncator moved, not duplicated).

---

## Layer 3 — LSP engine: worker + provision + manager

**DO:**
- `extensions/lib/lsp/worker.mjs` — generic JSON-RPC stdio worker (Content-Length
  framing, `initialize`, `didOpen/didChange/didClose`, `publishDiagnostics`).
  One Worker : one server. 16 MiB recv buffer, `for(;;)` breaks on incomplete
  frame + resets on breach. Assert `ready` before post; assert `Content-Length`
  parse; assert session-id uniqueness. Path via `import.meta.url`.
- `extensions/lib/lsp/provision.ts` — `resolveBin(spec, env)`: env-PATH-first
  `which(binName)` against merged env (`getToolEnv()` + `parseDotEnv(envPath)`)
  → reuse, no install; shell reuses `getShuckBinPath()`/`ensureShellTools()`.
  Else install user-scoped `getAgentDir()/lsp_envs/<lang>`: typescript bare
  `npm install --prefix <envDir> typescript-language-server@<ver> typescript@<tsVer>`
  (verify `--version`, reinstall on mismatch); python download static `uv` to
  `cache/uv/bin/uv` (R4 verify) → `uv venv` + `uv pip install pyrefly@<ver>`.
  Bounded `installTimeoutMs` 60s → `{ source:"install-failed" }`.
- `extensions/lib/lsp/manager.ts` — `LspManager` on `globalThis.__cpiLsp` (R5).
  `ensureSession`/`checkFile`/`lintText`/`fullCheck`/`stop`/`findSession`/`list`/
  `disposeAll`. `ensureSession` = single spawn point, idempotent on
  `(language,root)`, restarts on `envPath` change/`force`. `checkFile`:
  didOpen→await diag (`lintTimeoutMs`)→didClose. `lintText`: synthetic
  `/tmp/cpi-lsp-<n>.<ext>`, rootUri=null. `fullCheck`: spawn CLI checker
  (`tsc --noEmit -p <root>` / `pyrefly check` cwd=root), truncate via
  `output-truncate` (`checkMaxLines`/`checkMaxBytes`), overflow → session-dir log.
  `disposeAll` idempotent/reentrant (pending → `[]`). Branch-heavy: keep under
  355 AST, extract helpers if it creeps.

**VERIFY:**
- Fresh cache → real `npm install` of pinned TS server + `tsc` exists; `uv`
  download + attestation (or sha256 fallback) + `pyrefly` venv; idempotent
  re-run; pin bump re-provisions; network-killed → returns within 60s, no hang.
- Worker handshake against a real `typescript-language-server --stdio`:
  `didOpen` a file with a syntax error → `publishDiagnostics` `severity=error`.
- **Shuck parity baseline (GATE for Layer 4):** `lintText("shell", <bad bash>)`
  formatted output identical to today's `shell/lint.ts` output — capture
  before/after, diff empty.
- Worker-kill → session `dead`, removed, pending `lintText`→`[]`, next
  `ensureSession` respawns.

---

## Layer 4 — migration + `lsp` owner: shuck handoff + session disposal

Atomic set: lint rewrite + dispose drop + worker delete land together so no
extension imports a removed export.

**DO:**
- `extensions/shell/lint.ts` — rewrite `lintCommand` → `LspManager.lintText("shell", cmd)`.
  Keep `ShuckDiagnostic` as alias over `Diagnostic`; keep
  `formatDiagnostics`/`disposeLspClient` signatures (latter → no-op) so
  `shell.ts` + `repeat.ts` stay structurally stable (R3).
- `extensions/shell.ts` — drop `disposeLspClient()` call + now-unused import
  (lsp owner disposes all sessions). Keep under limit (R2).
- `extensions/lsp.ts` — sole owner. Registers unconditionally at load (no
  `globalThis` dedup boolean): the `lsp` tool (schema §7.1; commands
  `list_sessions|start|stop|check`; `project_dir`/`file`/`env`), system-prompt
  transform `lsp-behavior` (order 150, strip-then-append, reload-safe),
  `session_shutdown`→`manager.disposeAll()`. Semantics §7.2: file language wins
  over `project_dir`; `project_dir`/file→root ⇒ full-package check; `check`
  auto-starts; `start` re-invokable to restart on `env=` change. Output limits +
  overflow log (R1 truncator) per §7.4. `env=` reuses `parseDotEnv` from Layer 1.
- `extensions/env-capture.ts` — update `promptGuidelines` to add the `lsp`
  reload target now that `lsp` exists (`env=` on `sh`/`sh_repeat_until`/**`lsp`**).

**GATE (inside this layer, before delete):** parity diff from Layer 3 re-run
through `shell.ts`'s actual `lintCommand` import path — empty. Only then:

**DO:** delete `extensions/shell/lsp-worker.mjs`; confirm `rg lsp-worker` empty.

**VERIFY:**
- `lsp list_sessions` empty → `lsp start file=<repo .ts>` → returns
  id+state+bin+source, appears in list → `lsp check file=<.ts err>` → diagnostics
  → `lsp check project_dir=<repo>` → truncated `tsc` full check (overflow path
  returned if huge) → `lsp start file=… env=new.env` (from a `sh_env_capture`
  output) restarts → `lsp stop` gone.
- Normal `sh` still lints bad bash inline exactly as before (parity holds post-delete).
- Hot-reload `lsp.ts` mid-session → tool still registered, transform single-copy,
  no double-register, running sessions survive (real resource state).

---

## Layer 5 — producer diagnostics: shell post-edit hook + editor auto-LSP + guidelines

**DO:**
- `extensions/shell/edit-detect.ts` — `detectEdits(root): EditTarget[]` (pure AST,
  shape mirrors `shell/cd-targets.ts`). Patterns §8.2; dest must have a known
  source extension else skipped. Reuse `commands(root)`/`cmdArgs` (`shell/rules.ts`)
  + `JsonNode` (`lib/tree-sitter.ts`).
- `extensions/shell/lsp-hook.ts` — `postRunLspCheck(edits, ctx)` pure leaf: per
  target `languageByPath`→`discoverProjectRoot`→`findSession`; ready ⇒
  `checkFile`→formatted diagnostics appended; else one-time warning (dedup via
  `LspState.warned`, `queueMessage` `afterToolResult`) + inline note.
  Backgrounded → skip + note. `warned` is advisory-dedup only, never gates `checkFile`.
- `extensions/shell.ts` — after a completed (non-backgrounded/non-blocked) run call
  `postRunLspCheck(edits, ctx)`, append `appendedText`/queue `warning`. **Not
  inlined** (R2). (`env=` wiring already in place from Layer 1.)
- `extensions/llm-editor/tool.ts` — after successful `create`/`edit` write (not
  `view`): `languageByPath`→null skip silently; else `discoverProjectRoot`→
  `ensureSession` (bounded)→`checkFile`; append `<lsp project=… bin=… state=…>`
  + `<diagnostics>` + restart-`env=` hint to result XML. `install-failed` →
  edit still succeeds with `<lsp state="install-failed">` hint. Non-blocking.
- `extensions/llm-editor/result-xml.ts` — new fields. `text.toml`/`text.ts` —
  diagnostic / install-failed prose.
- Guidelines: finalize `lsp-behavior` transform block (§11) + per-tool
  `promptGuidelines` (`lsp`, `llm_editor` +1 line; `sh` +1 line already landed
  Layer 1; `sh_env_capture` already landed Layer 1, lsp reload line added Layer 4).

**VERIFY:**
- `sh "sed -i 's/x/y/' file.ts"` w/ ready TS session → sh result tail carries
  tsserver diagnostics for `file.ts`.
- Same w/ no session → exactly one warning (`lsp start file=…`); second run no
  dup; `checkFile` not gated by `warned`.
- `sh "echo x > file.md"` → skipped, no warning. Backgrounded edit → skip + note.
- `create` `.ts` w/ type error → result carries `<lsp>` + non-empty
  `<diagnostics>` naming project root; `edit` reuses session; `view` → no field.
- Force `install-failed` (corrupt cache/offline) → edit succeeds + hint, never
  blocks > 60s. `.md`/`.json` → no field.
- `shell.ts` re-measured ≤ limit (R2). Prompt-diff: new block exactly once;
  hot-reload each touched extension → `+1` line present once, no drift.

---

## Cross-cutting

- **Atomic migration set (Layer 4):** lint rewrite + dispose drop + worker delete
  together; worker delete only after parity GATE green.
- **Dependency order:** 1 (standalone) → 2 → 3 → 4 → 5. R1 truncator decided in
  Layer 2 (Layers 3+4 depend). `parseDotEnv` (Layer 1) consumed by Layers 3+4.
- Each layer one `jj` change; `jj split` if polluted.

## Definition of done (whole subsystem)

- Three languages reachable: typescript (`tsc`+tsserver), python
  (`pyrefly check`+`pyrefly lsp`), shell (shuck inline + post-edit).
- Env-provided binary reused over install (verified via `source`).
- `llm_editor` create/edit returns diagnostics; `view` does not.
- Shell editing commands auto-lint when session up, warn once when not.
- `sh`/`sh_repeat_until`/`lsp` accept `env=`; `sh_env_capture` feeds all three.
- Hot-reload of every touched extension safe (no dedup booleans; sessions
  survive; transforms single-copy).
- Every file ≤ 397 src lines / 355 AST; `shell.ts`+`repeat.ts` re-measured.
- No new npm deps; `uv` downloaded static; minisign untouched.
