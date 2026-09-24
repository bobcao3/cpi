# Using cpi

Install cpi with `pi install git:forge.bc3.moe/bob/cpi`. Restart pi after
installation; use `/reload` after changing local extensions or settings.

## Find a command

Type `/` in pi to browse available commands. Start with:

- `/fast`: switch between the current model and its `-fast` counterpart.
- `/goal`: set a persistent objective; use `pause`, `resume`, or `clear`.
- `/activity`: inspect background work without interrupting the agent.

See [the activity browser](activity.md) for keyboard and mouse controls. Ask the
agent about its tools and skills when you need a particular workflow. Use Pi's
`/thinking` command to change thinking level.

## Fast models

Fast is a model identity, not a separate mode. Existing same-provider `-fast`
registrations take precedence and remain unchanged.

Use pi's command help and completion for `/fast`, and `/model` for available
selections. See `fast` in
[`cpi-config.default.json`](../cpi-config.default.json) for configuration.

## Configure

Copy only the settings you want to change from
[`cpi-config.default.json`](../cpi-config.default.json) into
`~/.pi/agent/cpi-config.json`. Project overrides belong in
`.pi/cpi-config.json`.

Put personal instructions in `~/.pi/agent/rules/*.md`; project instructions
belong in `.pi/rules/*.md`. Provider fallback examples are in
[`fallback-providers.example.json`](../fallback-providers.example.json).

### Fork-probe model substitutions

See `forkProbe` in [`cpi-config.default.json`](../cpi-config.default.json).

## Compaction

- [Lifecycle and summary request](../extensions/lib/compaction.ts)
- [Checkpoint projection](../extensions/lib/compaction-checkpoint.ts)
- [User-facing display](../extensions/lib/compaction-display.ts)
- [Instruction selection and limits](../extensions/lib/compaction-references.ts)
- [Runtime snapshot](../extensions/lib/compaction-state.ts)
- [Summary/restoration templates](../extensions/text/compaction.toml) and
  [document markers](../extensions/text/compaction-references.toml)
- [Context integration coverage](../tools/sh-monitor/test-compaction-context.ts)
  and [live-provider verification](../tools/sh-monitor/test-compaction-live.ts)

## Develop locally

With pi and Bun installed, run `bun install`, then `pi install -l .` in this
checkout. Read [AGENTS.md](../AGENTS.md) before changing the implementation.
