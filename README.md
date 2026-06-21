# cpi - There are many agent harnesses, but this one is mine (Cheng Cao's)

Shared extensions and skills for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), installed at the **user-home level** (`~/.pi/agent/`) so every project inherits them.

## Project structure

```
cpi/
├── extensions/        # pi extensions, loaded live via jiti (hot-reloadable)
│   ├── lib/           # shared leaf modules: config, footer, agents, tree-sitter, cwd, …
│   ├── shell/         # the `sh` tool family: exec, lint, rules, highlight, cd-targets, status, repeat, transcript
│   ├── llm-editor/   # the AI-mediated `llm_editor` tool
│   └── *.ts          # owners/wrappers: core, shell, cwd, alarm, skill, effort, provider, vcs-jj, caveman-micro, …
├── skills/            # pi skills (subagents-in-pi)
├── tree-sitter-wasm/  # Zig build of tree-sitter-wasm.wasm (WASI: tree-sitter + bash + highlight query)
├── scripts/           # build / sign helpers
└── benchmarks/        # terminal-bench-3 harness
```

Two conventions shape every extension (full reasoning in `AGENTS.md`):

- **One owner per shared resource.** Shared plumbing — footer, notification renderer, prepend-message drains, system-prompt transforms, session-hold — lives in `core.ts`; every producer is a pure client of `lib/*`.
- **`globalThis` holds shared _state_, never dedup _flags_.** State survives jiti reloads; registration is guarded on real resource state (a live timer, an existing binary), not a boolean that would skip re-registration after a hot-reload.

## Headline features

- **AI-mediated file I/O.** The builtin `read`/`write`/`edit` are stripped and replaced by one `llm_editor` tool. `view`/`create`/`edit` delegate the reasoning to tool-less pi subagents (SWE-Edit); edits come back as search-replace blocks (whole-file rewrite fallback) and every view/edit is transcribed to `<dir>/<id>.md`.
- **A shell that corrects itself.** `sh` is stateless `bash -c` with backgrounding, signalling, and busy-wait detection. Each command is parsed with tree-sitter, then **linted** (a worker-thread Shuck LSP — no temp files, no per-call spawning) and checked against **AST rules** (`reject` blocks execution, `warn` surfaces to the agent) before it runs — e.g. enforcing `fd`/`rg` over `find`/`grep`. The same tree-sitter captures **syntax-highlight** the command in the TUI.
- **Live CWD + automatic project context.** `set_cwd` moves the working directory and re-announces it at 25/50/75% context-window boundaries. Since pi never reloads project context on a cwd change, cpi parses `cd <dir>` targets out of shell commands (and `set_cwd`) and surfaces the newly-entered tree's `AGENTS.md`/`CLAUDE.md` — each file at most once per process.
- **Resilient providers.** Configured providers register at startup; unusable ones are stripped (e.g. ambient cloud creds shadowing a real provider); on repeated errored turns the active model fails over to the next fitting fallback — race-free at `turn_end`.
- **A footer that tells the truth.** Line 1 shows the jj change/bookmark (overriding git), background-shell / repeat-monitor counts (`bg:N` / `mon:N`), and the caveman 🪨 marker when token compression is on.
- **Subagent orchestration.** The `subagents-in-pi` skill spawns child pi instances with a custom output protocol and a live transcript — used internally by `llm_editor` and available to the agent.

Plus: `alarm` (scheduled wake-ups that survive session resume), `/effort` (thinking-level tuning with clamp reporting), and the GLM-5.2 ↔ SGLang thinking bridge.

## How it works

cpi is a proper [pi package](https://pi.dev/docs/latest/packages). The `pi` manifest in `package.json` declares its `extensions/` and `skills/` directories, so `pi install` discovers every resource automatically — no settings patching, no symlinks, no per-file entries.

Pi reads the source files from disk at runtime (jiti, `moduleCache: false`), so:

| Action                             | Result                                         |
| ---------------------------------- | ---------------------------------------------- |
| Add a `.ts` to `extensions/`       | Live on next pi session — no re-install needed |
| Remove a file from `extensions/`   | Gone on next pi session                        |
| Edit an existing file              | Already live (pi reads from disk)              |
| Add a skill directory to `skills/` | Live on next pi session                        |

## Install

**Prerequisites:** The [pi coding agent](https://github.com/earendil-works/pi-coding-agent) must be installed and accessible as `pi` on your `PATH`.

### Dev (editable) install — local path

Point pi at this checkout. Source is read live, edits take effect on the next session, no tarball involved:

```bash
pi install /path/to/cpi          # user scope (~/.pi/agent), every project inherits
pi install -l .                   # project scope (.pi/settings.json), shareable + committed
```

Try without persisting:

```bash
pi -e /path/to/cpi
```

### Full install — published npm package

Once published to npm as `cpi`:

```bash
pi install npm:cpi                # floats; pi update --extensions picks up new versions
pi install npm:cpi@0.1.0          # pinned to a version
```

Publishing:

```bash
npm publish
```

The `files` field ships only `extensions/`, `skills/`, `cpi-config.default.json`, and `fallback-providers.example.json`. Core pi modules (`@earendil-works/*`, `typebox`) are `peerDependencies` and are **not** bundled — pi provides them at runtime.

After installation, start `pi` normally. The custom `sh` tool replaces the builtin `bash`, the `llm_editor` tool replaces `read`/`write`/`edit`, the `alarm` tool is available for scheduled wake-ups, and configured providers are registered automatically.

## Uninstall

```bash
pi remove /path/to/cpi            # dev install (use the same path you installed with)
pi remove npm:cpi                 # npm install
```

If you are migrating from the old `install.sh` method (directory entries patched directly into `settings.json`), run the bundled cleaner once to strip those legacy entries and any leftover symlinks:

```bash
/path/to/cpi/uninstall.sh
```

## Excluding extensions

To disable a specific extension without deleting the file, use `pi config` (interactive) or add a `!` exclusion filter to the package entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "/home/you/cpi",
      "extensions": ["extensions", "!extensions/disable-read-write-edit.ts"]
    }
  ]
}
```

The directory discovers all cpi extensions; the `!` pattern filters out `disable-read-write-edit.ts`. See the [pi settings docs](https://pi.dev/docs/latest/settings) for full glob/exclusion syntax.

## cpi Config

Extensions read their tunable parameters from a shared JSON config file,
merged from two locations:

| Scope   | Path                            | Purpose                                      |
| ------- | ------------------------------- | -------------------------------------------- |
| Default | `cpi-config.default.json`       | Shipped defaults — the documented base layer |
| User    | `~/.pi/agent/cpi-config.json`   | Defaults for all projects                    |
| Project | `<project>/.pi/cpi-config.json` | Override/add settings for a specific project |

### Merge rules

- **Deep merge**: nested objects are merged recursively; project values override user values for the same key.
- **Arrays**: project array replaces user array wholesale (same as pi's settings.json behavior).
- **Defaults**: any field absent from user/project config falls back to `cpi-config.default.json` (shipped, documented below).

### Schema

See `cpi-config.default.json` for the full documented defaults. Current sections:

```jsonc
{
  "shell": {
    "defaultWaitfor": 5, // seconds to wait before backgrounding (default: 5)
    "maxWaitfor": 30, // max allowed waitfor; larger errors (default: 30)
    "maxPreviewLines": 500, // agent head/tail line cap (default: 500)
    "previewMaxBytes": 10240, // agent head/tail byte cap (default: 10240)
    "maxAcc": 4194304, // in-memory output acc cap before trim (default: 4MB)
    "updateMs": 200, // min ms between streaming partials; 0 = off (default: 200)
    "tailLines": 5, // TUI folded-preview lines, independent of head/tail (default: 5)
    "describeMax": 48, // max chars of the `describe` summary in UI (default: 48)
  },
}
```

### Shell

Controls the `sh` tool's execution and output truncation. All values are
reflected in the tool's schema description, guidelines, and validation at
runtime, so the model always sees the effective limits.

| Setting           | Type   | Default   | Range          | Description                                                                   |
| ----------------- | ------ | --------- | -------------- | ----------------------------------------------------------------------------- |
| `defaultWaitfor`  | number | `5`       | > 0            | Seconds to wait before backgrounding when no `waitfor` is passed              |
| `maxWaitfor`      | number | `30`      | > 0            | Maximum allowed `waitfor`; larger values are rejected with an error           |
| `maxPreviewLines` | number | `500`     | 1–10000        | Agent-facing head/tail line cap (also the default tail when neither is given) |
| `previewMaxBytes` | number | `10240`   | 1024–1048576   | Agent-facing head/tail byte cap (whichever limit hits first wins)             |
| `maxAcc`          | number | `4194304` | 65536–67108864 | Max bytes accumulated in memory per shell before trimming                     |
| `updateMs`        | number | `200`     | 0–60000        | Min ms between streaming partial updates; `0` disables throttling             |
| `tailLines`       | number | `5`       | 1–200          | TUI folded-preview line count — independent of agent head/tail                |
| `describeMax`     | number | `48`      | 8–200          | Max chars of the `describe` summary shown in the UI                           |

`tailLines` (TUI folding) and `maxPreviewLines`/`previewMaxBytes` (agent
truncation) are independent: changing one never affects the other.

## Fallback Providers Config

`provider.ts` reads provider/model definitions and fallback order
from two JSON files, merged at session start:

| Scope   | Path                                    | Purpose                                               |
| ------- | --------------------------------------- | ----------------------------------------------------- |
| User    | `~/.pi/agent/fallback-providers.json`   | Default providers + fallback order for all projects   |
| Project | `<project>/.pi/fallback-providers.json` | Override/add providers; reorder fallbacks per-project |

### Merge rules

- **`providers`**: deep merge — project entries override user entries by provider key. Within a provider, project's full config replaces user's.
- **`fallbacks`**: project list replaces user list entirely (so projects can reorder or prune). If project has no `fallbacks` key, user's are kept.

### Schema

See `fallback-providers.example.json` for a template. Key fields:

```jsonc
{
  "providers": {
    "my-provider": {
      "name": "Display Name",
      "baseUrl": "https://endpoint/v1",
      "api": "openai-completions",
      "apiKey": "NO", // "NO" = no auth; otherwise literal key
      "models": [
        {
          "id": "model-id",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 262144,
          "maxTokens": 16384,
        },
      ],
    },
  },
  "fallbacks": [{ "provider": "my-provider", "model": "model-id" }],
}
```

### Behavior

Two distinct behaviors, both in `provider.ts`:

**Behavior 1 — startup (`provider.ts`):** upon pi start, all providers from merged config are registered, then unusable ones are **stripped** via configurable provider:auth matching (`strip` rules; defaults to env-based `amazon-bedrock` / `huggingface`, whose ambient cloud creds shadow real providers). If the active model is missing or was just stripped, the first fallback candidate whose context window fits is selected.

**Behavior 2 — runtime (`provider.ts`):** when an endpoint fails repeatedly — assistant turns ending with `stopReason: "error"` (pi surfaces these after exhausting its own retries, i.e. "pi's limits") — the active model is switched to the **next** fallback candidate, but only if that candidate's `contextWindow` fits the current context ("if context allows"). The switch is applied at the `turn_end` where the failure threshold is crossed: the failed call is complete by then, so swapping is race-free, and pi's remaining retries run against the new model — seamless failover with no need to re-send the prompt. The error just counted is attributed to the provider active at the time of the failure (read before the swap); subsequent turns attribute to the new provider, so there is no misattribution.

### Config: `strip` and `failover`

```jsonc
{
  "providers": {
    /* ... */
  },
  "fallbacks": [{ "provider": "p", "model": "m" }],
  "strip": [
    { "provider": "amazon-bedrock", "env": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID"], "match": "any" },
    { "provider": "huggingface", "env": ["HF_TOKEN"], "match": "all" },
  ],
  "failover": { "failureThreshold": 3 },
}
```

- **`strip`** (optional): list of `{ provider, env[], match }`. `match: "any"` strips when any env is set (default); `"all"` requires all. Omit to use the built-in bedrock/huggingface defaults; set `[]` to disable stripping.
- **`failover.failureThreshold`** (optional, default `3`): consecutive errored turns before switching models.

Set `PF_DEBUG=1` (e.g., `PF_DEBUG=1 pi`) to trace decisions: strip/failover logs to stderr, config loads to `/tmp/provider-fallback-debug.log`.

## Adding new extensions/skills

1. Drop the `.ts` file into `extensions/` (or create a `skills/<name>/` directory).
2. Restart pi — the package manifest already points pi at `extensions/` and `skills/`, so the new file is auto-discovered.

No re-install needed (dev install reads from disk; npm consumers update with `pi update --extensions`).

## Contributing

This repo is managed with [**Jujutsu (`jj`)**](https://jj-vcs.dev), a
Git-compatible VCS. Using `jj` is recommended — `jj fix` runs Prettier
automatically on `.ts`/`.js`/`.json`/`.md` files via `bun`. To get started:
`jj fix` after making changes, and `jj log` to explore history.

<!-- vim: set nowrap tabstop=4 shiftwidth=4 expandtab spell: -->
