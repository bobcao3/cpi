# cpi - There are many agent harnesses, but this one is mine (Cheng Cao's)

Shared extensions and skills for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), installed at the **user-home level** (`~/.pi/agent/`) so every project inherits them.

## What each extension does

| Extension                      | Purpose                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/config.ts`                | Shared config loader: reads `cpi-config.json` (user + project), deep-merges, provides typed accessors for each extension.                               |
| `lib/footer.ts`                | Shared footer engine: `setBranchResolver`/`registerLineSegment` let extensions add line-1 data without owning the footer.                               |
| `footer/index.ts`              | Owns pi's custom footer: renders line 1, splices built-in footer lines 2/3. Other extensions must not call `setFooter`.                                 |
| `vcs-jj/index.ts`              | Shows jj change id/bookmark on footer line 1, overriding git branch. Bounded cached `.jj` lookup; no shell-out at render.                               |
| `shell.ts`                     | Replaces builtin `bash` with stateless `sh` tool: backgrounding, signalling, busy-wait detection; strips bash on reload.                                |
| `hold.ts`                      | Single owner of session-hold: one combined hold notice + one deadline await across alarm/shell (no stacked shutdown holds).                             |
| `system-prompt.ts`             | Single owner of `before_agent_start` system-prompt transforms (strip-skills, caveman-append) in declared order.                                         |
| `shell/status.ts`              | Adds background-shell / repeat-monitor counts (`bg:N` / `mon:N`) flush-right on footer line 1 via `registerRightSegment`.                               |
| `caveman-micro/index.ts`       | Toggles caveman-micro token-compression prompt (default on); shows `🪨` flush-right on footer line 1. Reads `caveman` config from `cpi-config.json`.    |
| `alarm.ts`                     | `alarm` tool for scheduled wake-ups (relative or absolute time). Survives session resume.                                                               |
| `skill.ts`                     | `skill` tool: loads full `SKILL.md` by name so the agent can use skills even though builtin `read` is stripped.                                         |
| `disable-read-write-edit.ts`   | Strips builtin `read`/`write`/`edit` — all file I/O goes through `sh`.                                                                                  |
| `provider-strip.ts`            | Startup (behavior 1): registers providers from JSON config; strips unusable ones via configurable provider:auth rules (defaults: env-based Bedrock/HF). |
| `provider-failover.ts`         | Runtime (behavior 2): on repeated endpoint failures (errored turns ≥ threshold), switches to the next fallback candidate whose context window fits.     |
| `subagent-transcript/index.ts` | Streams live markdown transcript to stderr in print mode (`pi -p` / subagent runs); surfaces jsonl path + run summary.                                  |
| `glm52-sglang-thinking.ts`     | Bridges GLM-5.2 thinking to SGLang `chat_template_kwargs`.                                                                                              |

## Skills

| Skill              | Purpose                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `editing-files/`   | Teaches the model a fuzzy patch application workflow for applying file edits without exact line numbers.                                                                       |
| `subagents-in-pi/` | Orchestrates subagent sessions — spawning child pi instances with a custom system prompt (`output-protocol.md`) via `subagent.sh`, with results captured in a live transcript. |

## How it works

`install.sh` is a **one-time** setup. It patches `~/.pi/agent/settings.json` to
point pi directly at the cpi source **directories**:

```json
{
  "extensions": ["/home/you/cpi/extensions"],
  "enableSkillCommands": true,
  "skills": ["/home/you/cpi/skills"]
}
```

<details>
<summary><strong>Why directories, not globs?</strong></summary>

In pi's settings, a _plain_ path entry (file or directory) is what gets
**discovered** — pi collects the extension/skill files under it. An entry
containing `*`/`?` (or starting with `!`/`+`/`-`) is treated as a _filter
pattern_ applied to the discovered set; it does **not** discover files itself.
So a bare glob like `extensions/*.ts` with no plain path matches nothing and
**loads zero extensions** — the bug this install fixes. The directory entry is
the live link.

</details>

No symlinks are created. Pi reads from the source files at runtime, so:

| Action                             | Result                                         |
| ---------------------------------- | ---------------------------------------------- |
| Add a `.ts` to `extensions/`       | Live on next pi session — no re-install needed |
| Remove a file from `extensions/`   | Gone on next pi session                        |
| Edit an existing file              | Already live (pi reads from disk)              |
| Add a skill directory to `skills/` | Live on next pi session                        |

## Install

**Prerequisites:** The [pi coding agent](https://github.com/earendil-works/pi-coding-agent) must be installed and accessible as `pi` on your `PATH`.

```bash
~/cpi/install.sh
```

Run **once**. Re-running is safe (idempotent) — it cleans up old symlinks and
stale glob entries from previous versions, re-syncs the settings.json directory
entries, then invokes `pi` non-interactively to verify the extensions actually
loaded (custom `sh`/`alarm` tools present, builtin `bash` stripped, providers
registered).

After installation, start `pi` normally. The custom `sh` tool replaces the
builtin `bash`, the `alarm` tool is available for scheduled wake-ups, and
configured providers are registered automatically.

## Uninstall

```bash
~/cpi/uninstall.sh
```

Removes the cpi entries from `settings.json` and cleans up any remaining
symlinks from the old install method.

## Excluding extensions

To disable a specific extension without deleting the file, add a `!` exclusion
pattern to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/you/cpi/extensions", "!/home/you/cpi/extensions/disable-read-write-edit.ts"]
}
```

The directory entry discovers all cpi extensions; the `!` pattern then filters
out `disable-read-write-edit.ts`. `install.sh` preserves any `!`/`+`/`-` filter patterns
you add here when it re-syncs. See the
[pi settings docs](https://pi.dev/docs/latest/settings) for full glob/exclusion
syntax.

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

`provider-strip.ts` + `provider-failover.ts` read provider/model definitions and fallback order
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

Two distinct behaviors, one per extension:

**Behavior 1 — startup (`provider-strip.ts`):** upon pi start, all providers from merged config are registered, then unusable ones are **stripped** via configurable provider:auth matching (`strip` rules; defaults to env-based `amazon-bedrock` / `huggingface`, whose ambient cloud creds shadow real providers). If the active model is missing or was just stripped, the first fallback candidate whose context window fits is selected.

**Behavior 2 — runtime (`provider-failover.ts`):** when an endpoint fails repeatedly — assistant turns ending with `stopReason: "error"` (pi surfaces these after exhausting its own retries, i.e. "pi's limits") — the active model is switched to the **next** fallback candidate, but only if that candidate's `contextWindow` fits the current context ("if context allows"). The switch is armed at the failure threshold and applied on the next user `input` (agent idle), never mid-retry, to avoid racing pi's in-flight request or misattributing the old model's errors.

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
2. Restart pi — the new file is auto-discovered from the directory entry already in `settings.json`.

No need to re-run `install.sh`.

## Contributing

This repo is managed with [**Jujutsu (`jj`)**](https://jj-vcs.dev), a
Git-compatible VCS. Using `jj` is recommended — `jj fix` runs Prettier
automatically on `.ts`/`.js`/`.json`/`.md` files via `bun`. To get started:
`jj fix` after making changes, and `jj log` to explore history.
