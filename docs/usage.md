# Using cpi

Install cpi with `pi install git:forge.bc3.moe/bob/cpi`. Restart pi after
installation; use `/reload` after changing local extensions or settings.

## Find a command

Type `/` in pi to browse available commands. Start with:

- `/effort`: inspect or change the thinking budget.
- `/fast`: toggle Fast mode on supported models.
- `/goal`: set a persistent objective; use `pause`, `resume`, or `clear`.
- `/activity`: inspect background work without interrupting the agent.

See [the activity browser](activity.md) for keyboard and mouse controls. Ask the
agent about its tools and skills when you need a particular workflow.

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

## Develop locally

With pi and Bun installed, run `bun install`, then `pi install -l .` in this
checkout. Read [AGENTS.md](../AGENTS.md) before changing the implementation.
