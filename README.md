# cpi — Cheng Cao's pi extensions & skills

Shared extensions and skills for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent), installed
at the **user-home level** (`~/.pi/agent/`) so every project inherits them.

## Usage

### Install

Release install — a normal, non-editable copy managed by pi:

```bash
pi install git:forge.bc3.moe/bob/cpi          # latest main
pi install git:forge.bc3.moe/bob/cpi@<tag>    # pinned release
```

`pi update --extensions` reconciles an existing install to its pinned ref.

cpi supports Linux, macOS, WSL, and native Windows PowerShell. On native
Windows, it automatically uses `pwsh`, then Windows PowerShell, and provisions
`fd`/`rg` into its cache. Bash-oriented examples use POSIX syntax; PowerShell
users should use equivalent quoting.

### Slash commands

| Command   | Why it matters to you                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/effort` | Control the thinking budget: no arg shows the current level; `/effort <level>` sets it (`off\|minimal\|low\|medium\|high\|xhigh`). If the model can't do the level you asked for, you're told — no silent degradation. |
| `/fast`   | Use Fast mode for eligible OpenAI/OpenAI-Codex requests: no arg toggles it; accepted arguments are `on`, `off`, and `toggle`. Start with `--fast` to enable it.                                                        |
| `/goal`   | Give the session a persistent objective it verifies and keeps working toward across turns until met. No arg = status; `clear` / `pause` / `resume`.                                                                    |

### Built-in skills

Loaded via the `skill` tool (each has its own `SKILL.md`):

- `subagents-in-pi` — delegate to child pi agents for parallel or background
  work, with a live transcript; the file tools use this under the hood.
- `env-capture` — snapshot the current shell env (a venv, exported vars) into a
  session dotenv, reloadable via `env=` on `sh` / `sh_repeat_until` / `lsp`.
- `debate-review-rebuttle` — get code or docs reviewed through an adversarial
  debate (review → rebut → adjudicate) so you see verified findings, not noise.

### Configuration

Per-user (`~/.pi/agent/`) with optional per-project overrides (`.pi/` in the
project). Three mechanisms:

| Mechanism                 | What it configures                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `cpi-config.json`         | Check `cpi-config.default.json`                                                                            |
| `rules/*.md`              | User rules first, project rules after                                                                      |
| `fallback-providers.json` | Provider definitions, fallback order, and provider/model stripping — see `fallback-providers.example.json` |

## Features

- **File I/O.** `read`/`write`/`edit` replace the builtins with a careful
  pipeline: query-reads surface only the relevant lines, edits land as precise
  search-replace hunks. Images inline for vision models.
- **Rule-checked shell commands.** `sh` runs through your configured Bash/POSIX
  shell or PowerShell with backgrounding and busy-wait detection. Commands are
  checked against your AST rules before execution — `reject` blocks a bad
  command outright, `warn` flags it — so habits like `find` over `fd` are caught
  automatically. Long output is truncated, slow jobs background with a live log
  and completion notification; `sh_signal` and `sh_repeat_until` manage
  background and polling work.
- **Orientation that survives long sessions.** `set_cwd` moves the session
  between projects; the working directory is re-announced at 25/50/75% context
  usage, and `cd` targets in shell commands surface the new project's
  instructions. No more "which project am I in" drift.
- **Sessions that survive endpoint failures.** Unusable providers are stripped
  at startup (ambient cloud credentials can't shadow your real provider), stale
  model variants are removed from model selection, and repeated errored turns
  fail over to the next fitting model automatically — no mid-session
  reconfiguration.
- **Fast mode when available.** Eligible OpenAI/OpenAI-Codex requests can use
  Fast mode.
- **A no-frills status row.** The standard pi footer keeps showing its normal
  information; the custom status row adds your jj change/bookmark, `⚡fast`
  while active, and how many background shells and repeat monitors run.
- **One LSP story.** `lsp` starts/stops/checks language servers; shell linting
  and the editor tooling are clients of the same servers, so everything agrees
  on one source of truth.
- **Your conventions, enforced.** Drop a markdown file into `rules/` (user or
  project scope) and the session follows it every turn.
- **Small conveniences.** `alarm` (come back at a set time, survives resume),
  `wait_any` (end your turn instead of polling), cost-tree (per-subagent cost
  roll-up), and a live transcript stream for subagent runs.

## Development

### Dev install

Editable install for developing cpi itself — reads sources from disk, no
re-install after edits. **Prerequisites:** `pi` on your PATH and bun.

```bash
bun install -g --ignore-scripts @earendil-works/pi-coding-agent   # once
bun install --omit=peer                                           # cpi's own deps
pi install -l .                                                   # link into pi's project scope
```

`pi -e /path/to/cpi` tries without persisting the link.

### Architecture & Basics

cpi is a proper [pi package](https://pi.dev/docs/latest/packages): the manifest
in `package.json` declares `extensions/` and `skills/`, so `pi install`
discovers every resource automatically. Source is read live (jiti,
`moduleCache: false`) — a new `.ts` in `extensions/` is live on the next
session, no re-install.

- **One owner per shared resource.** Footer, notification renderer,
  prepend-message drains, system-prompt transforms, and session-hold all live in
  `extensions/core.ts`; producers are pure clients of `lib/*`.
- **`globalThis` holds shared state, never dedup flags.** Registration is
  guarded on real resource state (a live timer, an existing binary), so
  hot-reloads re-register instead of silently breaking.
- **Subagents stay local and isolated.** Root pi owns private local RPC
  endpoints and worker threads, avoiding nested pi process trees while
  preserving context isolation. They may run as `sh`-tracked background jobs,
  but cannot detach: root pi owns their Worker threads and cancels/terminates
  them when it exits.

This repo is managed with [Jujutsu (`jj`)](https://jj-vcs.dev); `jj fix` runs
Prettier. Full conventions live in `AGENTS.md`.

<!-- vim: set nowrap tabstop=4 shiftwidth=4 expandtab spell: -->
