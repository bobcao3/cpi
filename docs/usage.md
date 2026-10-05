# Using cpi

Install the packaged application using the
[CLI instructions](../packages/cli/README.md) and run `cpi`. Use `/reload` after
changing local extensions or settings.

## Commands and configuration

Type `/` to browse commands. See [the activity browser](activity.md) for
background-work visibility. Ask the agent about its tools and skills when you
need a particular workflow. Use Pi's `/thinking` command to change thinking
level.

Configuration settings are defined in
[`cpi-config.default.json`](../packages/extensions/cpi-config.default.json);
configuration locations and override behavior are defined by
[`config.ts`](../packages/extensions/extensions/lib/config.ts). Copy only the
settings you want to override. Provider fallback examples are in
[`fallback-providers.example.json`](../packages/extensions/fallback-providers.example.json).

## Compaction

The [compaction lifecycle](../packages/extensions/extensions/lib/compaction.ts)
coordinates the
[checkpoint](../packages/extensions/extensions/lib/compaction-checkpoint.ts),
[display](../packages/extensions/extensions/lib/compaction-display.ts),
[reference selection](../packages/extensions/extensions/lib/compaction-references.ts),
and
[runtime snapshot](../packages/extensions/extensions/lib/compaction-state.ts).
Model-facing instructions live in the
[summary templates](../packages/extensions/extensions/text/compaction.toml) and
[reference templates](../packages/extensions/extensions/text/compaction-references.toml).

See
[context integration coverage](../packages/extensions/scripts/harness/test-compaction-context.ts)
and
[live-provider verification](../packages/extensions/scripts/harness/test-compaction-live.ts).

## Develop locally

Read [AGENTS.md](../AGENTS.md) and the [artifact workflow](../README.md). Local
extension development uses `packages/extensions`, not the repository root as a
Pi extension package. Release verification uses installed fork artifacts.
