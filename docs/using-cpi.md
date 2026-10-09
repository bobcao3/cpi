# Using cpi

Install the packaged application using the
[CLI instructions](../packages/cli/README.md) and run `cpi`. Use `/reload` after
changing local extensions or settings.

## Commands and configuration

Type `/` to browse commands. Use Pi's `/thinking` command to change thinking
level. Ask the agent about its tools and skills when you need a particular
workflow.

Configuration merges over the shipped defaults in two steps: the user config in
the agent directory (see [storage](storage.md)), then the project config at
`.cpi/cpi-config.json`. Project settings win, nested objects merge, and arrays
replace. Keys and defaults live in
[`cpi-config.default.json`](../packages/harness/cpi-config.default.json);
the merge implementation is the authority in
[`config.ts`](../packages/harness/src/lib/config.ts). Copy only the
settings you want to override. Provider fallback examples are in
[`fallback-providers.example.json`](../packages/harness/fallback-providers.example.json).

## Topics

- [Background work](background-work.md) — shells, signals, detach, monitors, shutdown.
- [Session events](session-events.md) — what wakes an idle agent.
- [Activity browser](activity-browser.md) — inspect running work.
- [Storage](storage.md) — where sessions, caches, and sockets live.
- [Goals](goals.md) and [LSP sessions](lsp.md).
- [Editor tools](editor-tools.md) — read, edit, apply_patch, write.
- [External event subscriptions](external-event-subscriptions.md) — producer contract.
- [Tool tree presentation design](tool-tree-presentation-design.md) — proposal, not shipped behavior.

## Compaction

When the context window fills, compaction summarizes the conversation and
restores two things: managed project instructions and a runtime-state
checkpoint. Skill bodies are not restored — reload the skills the continuing
work needs by name. The lifecycle lives in
[`compaction.ts`](../packages/harness/src/lib/compaction.ts); verify
with the
[context integration coverage](../packages/harness/scripts/harness/test-compaction-context.ts)
and [live-provider check](../packages/harness/scripts/harness/test-compaction-live.ts).

## Develop locally

Read [AGENTS.md](../AGENTS.md) and the [artifact workflow](../README.md). Local
extension development uses `packages/harness`, not the repository root as a
Pi extension package. Release verification uses installed fork artifacts.
