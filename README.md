# cpi - There are many agent harnesses, but this one is mine (Cheng Cao's)

Shared extensions and skills for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), installed at the **user-home level** (`~/.pi/agent/`) so every project inherits them.

## What each extension does

| Extension                      | Purpose                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/config.ts`                | Shared config loader: reads `cpi-config.json` (user + project), deep-merges, provides typed accessors for each extension.                               |
| `lib/footer.ts`                | Shared footer engine: `setBranchResolver`/`registerLineSegment` let extensions add line-1 data without owning the footer.                               |
| `core.ts`                     | Single owner of all shared cpi plumbing: footer, notification renderer, prepend-message drains, system-prompt transforms, session-hold. Producers call `lib/*` only.                 |
| `vcs-jj/index.ts`              | Shows jj change id/bookmark on footer line 1, overriding git branch. Bounded cached `.jj` lookup; no shell-out at render.                               |
| `shell.ts`                     | Replaces builtin `bash` with stateless `sh` tool: backgrounding, signalling, busy-wait detection; strips bash on reload.                                |
| `shell/status.ts`              | Adds background-shell / repeat-monitor counts (`bg:N` / `mon:N`) flush-right on footer line 1 via `registerRightSegment`.                               |
| `caveman-micro/index.ts`       | Toggles caveman-micro token-compression prompt (default on); shows `🪨` flush-right on footer line 1. Reads `caveman` config from `cpi-config.json`.    |
| `alarm.ts`                     | `alarm` tool for scheduled wake-ups (relative or absolute time). Survives session resume.                                                               |
| `skill.ts`                     | `skill` tool: loads full `SKILL.md` by name so the agent can use skills even though builtin `read` is stripped.                                         |
| `disable-read-write-edit.ts`   | Strips builtin `read`/`write`/`edit` — all file I/O goes through `sh`.                                                                                  |
| `provider.ts`                 | Provider/model lifecycle: startup strip (register + strip unusable + pick first fitting fallback) and runtime failover on repeated errored turns.                                  |
| `subagent-transcript/index.ts` | Streams live markdown transcript to stderr in print mode (`pi -p` / subagent runs); surfaces jsonl path + run summary.                                  |
| `glm52-sglang-thinking.ts`     | Bridges GLM-5.2 thinking to SGLang `chat_template_kwargs`.                                                                                              |

## Skills

| Skill              | Purpose                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagents-in-pi/` | Orchestrates subagent sessions — spawning child pi instances with a custom system prompt (`output-protocol.md`) via `subagent.sh`, with results captured in a live transcript. |

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

After installation, start `pi` normally. The custom `sh` tool replaces the builtin `bash`, the `alarm` tool is available for scheduled wake-ups, and configured providers are registered automatically.

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
    { "source": "/home/you/cpi", "extensions": ["extensions", "!extensions/disable-read-write-edit.ts"] }
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
