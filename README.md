# cpi - There are many agent harnesses, but this one is mine (Cheng Cao's)

Shared extensions and skills for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), installed at the **user-home level** (`~/.pi/agent/`) so every project inherits them.

## What each extension does

| Extension                    | Purpose                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `lib/config.ts`              | Shared config loader: reads `cpi-config.json` (user + project), deep-merges, provides typed accessors for each extension. |
| `shell.ts`                   | Replaces builtin `bash` with stateless `sh` tool: backgrounding, signalling, busy-wait detection, session-hold.           |
| `alarm.ts`                   | `alarm` tool for scheduled wake-ups (relative or absolute time). Survives session resume.                                 |
| `skill.ts`                   | `skill` tool: loads full `SKILL.md` by name so the agent can use skills even though builtin `read` is stripped.           |
| `disable-bash.ts`            | Strips the builtin `bash` tool so only the custom `sh` is available.                                                      |
| `disable-read-write-edit.ts` | Strips builtin `read`/`write`/`edit` — all file I/O goes through `sh`.                                                    |
| `provider-fallback.ts`       | Registers custom model providers from JSON config; disables env-based Bedrock/HF; falls back to configured candidates.    |
| `transcript.ts`              | Writes live markdown transcript when `PI_TRANSCRIPT_MD` is set (used by subagent.sh).                                     |
| `glm52-sglang-thinking.ts`   | Bridges GLM-5.2 thinking to SGLang `chat_template_kwargs`.                                                                |

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
  "extensions": ["/home/you/cpi/extensions", "!/home/you/cpi/extensions/disable-bash.ts"]
}
```

The directory entry discovers all cpi extensions; the `!` pattern then filters
out `disable-bash.ts`. `install.sh` preserves any `!`/`+`/`-` filter patterns
you add here when it re-syncs. See the
[pi settings docs](https://pi.dev/docs/latest/settings) for full glob/exclusion
syntax.

## cpi Config

Extensions read their tunable parameters from a shared JSON config file,
merged from two locations:

| Scope   | Path                            | Purpose                                      |
| ------- | ------------------------------- | -------------------------------------------- |
| User    | `~/.pi/agent/cpi-config.json`   | Defaults for all projects                    |
| Project | `<project>/.pi/cpi-config.json` | Override/add settings for a specific project |

### Merge rules

- **Deep merge**: nested objects are merged recursively; project values override user values for the same key.
- **Arrays**: project array replaces user array wholesale (same as pi's settings.json behavior).
- **Defaults**: any field not present in either config file falls back to built-in defaults.

### Schema

See `cpi-config.example.json` for a template. Current sections:

```jsonc
{
  "shell": {
    "defaultWaitfor": 5, // seconds to wait before backgrounding (default: 5)
    "maxWaitfor": 30, // maximum allowed waitfor; larger values error (default: 30)
  },
}
```

### Shell

Controls the `sh` tool's `waitfor` behavior:

| Setting          | Type   | Default | Description                                                                |
| ---------------- | ------ | ------- | -------------------------------------------------------------------------- |
| `defaultWaitfor` | number | `5`     | Seconds to wait before backgrounding a command when no `waitfor` is passed |
| `maxWaitfor`     | number | `30`    | Maximum allowed `waitfor` value; larger values are rejected with an error  |

These values are reflected in the tool's schema description, guidelines, and
validation logic at runtime, so the model always sees the effective limits.

## Fallback Providers Config

`provider-fallback.ts` reads provider/model definitions and fallback order
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

1. All providers from merged config are registered at extension load (before model resolution).
2. At `session_start`, env-based `amazon-bedrock` and `huggingface` providers are disabled (their ambient creds shadow real providers in cloud environments).
3. If no usable model is active (or the active one was just disabled), each fallback candidate is tried in order until `setModel` succeeds.
4. Set the `PF_DEBUG=1` environment variable before launching pi (e.g., `PF_DEBUG=1 pi`) to trace provider-fallback decisions to `/tmp/provider-fallback-debug.log`.

## Adding new extensions/skills

1. Drop the `.ts` file into `extensions/` (or create a `skills/<name>/` directory).
2. Restart pi — the new file is auto-discovered from the directory entry already in `settings.json`.

No need to re-run `install.sh`.

## Contributing

This repo is managed with [**Jujutsu (`jj`)**](https://jj-vcs.dev), a
Git-compatible VCS. Using `jj` is recommended — `jj fix` runs Prettier
automatically on `.ts`/`.js`/`.json`/`.md` files via `bun`. To get started:
`jj fix` after making changes, and `jj log` to explore history.
