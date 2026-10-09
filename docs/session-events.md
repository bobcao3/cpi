# Session events

An idle agent wakes on the next event, not on a timer. The event sources are:

- a user message or queued follow-up;
- a tracked background shell completing or failing, per
  [background work](background-work.md);
- an alarm scheduled with the `alarm` tool;
- a notification from an external event source, per
  [external event subscriptions](external-event-subscriptions.md);
- in headless holds, the anti-stuck check, which asks a probe model whether to
  keep waiting or to resume the agent.

`wait_any` ends the turn and yields: it produces no work of its own, and the
next event starts a new turn. Polling is never required. The model-facing rules
are the authorities in
[`wait-any.toml`](../packages/harness/src/text/wait-any.toml) and
[`alarm.toml`](../packages/harness/src/text/alarm.toml).

While a headless session holds for pending work, the hold ends on an event, on
user input, or on the anti-stuck probe; scheduling lives in
[`core.ts`](../packages/harness/src/core.ts) and
[`anti-stuck.ts`](../packages/harness/src/lib/anti-stuck.ts).
