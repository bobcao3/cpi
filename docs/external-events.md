# External event subscriptions

A producer extension can observe a job, order, or remote service without running
another agent loop. Use cpi's acknowledged `pi.events` channel from a command or
tool after session startup. No cpi filesystem import, socket, or model client is
needed.

The public request/handle interfaces and resource limits are defined in
[`external-events.ts`](../extensions/lib/external-events.ts). The channel is
`cpi:register-event-source:v1`. `reply(handle)` is a **synchronous**
acknowledgement: if `emit` returns without a reply, the bridge is unavailable or
rejected the registration. Do not claim that notifications are armed in that
case. Registration requires a unique source ID within the current owner; one
source can represent several bounded subscriptions.

- `hasPending()` reports active subscriptions, not whether a notification is
  queued. It and `noticeText()` must be inexpensive synchronous functions.
- `notify(summary, data)` accepts a JSON-compatible record. `true` means
  submitted to pi, not that a model has processed it. `false` means
  stale/disposed, invalid data, backpressure, or synchronous delivery failure.
  Producers must surface failure or retain a bounded retry/coalescing buffer;
  never retry in an unbounded loop.
- `changed()` rechecks pending state after expiry, cancellation, or completion.
  It does not create a notification or start a model turn.
- `dispose()` unregisters the source and calls `onAbort()` once. It is
  idempotent. `onAbort()` must stop **observers only**, not cancel broker orders
  or business operations. It is synchronous, best-effort cleanup; do not perform
  awaited work inside it.

Use a producer-owned bounded subscription expiry. cpi's shutdown drain cap is
not a subscription expiry. On a terminal event, publish the event even when it
clears the last pending subscription, then call `changed()` or `dispose()`.
Expiry should normally publish an expiry event too, so the agent can decide what
to do next. Clear subscriptions without a notification only when no response is
needed.

## Producer example

This adapter accepts an existing EventEmitter; it does not create IPC or perform
business operations. Call it **before** starting the action being observed. The
caller must validate and bound `expiryMs` using its own subscription policy.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventEmitter } from "node:events";

type Handle = {
  notify(summary: string, data: Record<string, unknown>): boolean;
  changed(): void;
  dispose(): void;
};

export function observeJob(
  pi: ExtensionAPI,
  events: EventEmitter,
  jobId: string,
  expiryMs: number,
  deliveryFailed: () => void,
) {
  let handle: Handle | undefined;
  let pending = true;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const eventName = `job:${jobId}`;
  const cleanup = () => {
    pending = false;
    clearTimeout(expiry);
    events.off(eventName, forward);
  };
  const forward = (event: { status: string; terminal: boolean }) => {
    if (!pending) return;
    if (event.terminal) pending = false;
    const accepted = handle!.notify(`Job ${jobId}: ${event.status}`, {
      jobId,
      status: event.status,
      terminal: event.terminal,
    });
    handle!.changed();
    if (event.terminal || !accepted) handle!.dispose();
    if (!accepted) deliveryFailed();
  };
  pi.events.emit("cpi:register-event-source:v1", {
    id: `jobs:${jobId}`,
    hasPending: () => pending,
    noticeText: () => `observing job ${jobId}`,
    onAbort: cleanup,
    reply: (value: Handle) => {
      handle = value;
    },
  });
  if (!handle) throw new Error("cpi event subscriptions unavailable");
  events.on(eventName, forward);
  expiry = setTimeout(
    () => forward({ status: "observation-expired", terminal: true }),
    expiryMs,
  );
  return () => handle!.dispose();
}
```

The producer also owns cleanup of its connection/client on `session_shutdown`.
Do not persist handles, restore subscriptions implicitly from transcript
history, or reuse captured extension APIs after session replacement or reload.
Register fresh subscriptions explicitly in the new session. Registering from a
tool avoids relying on relative `session_start` handler order.

## Delivery and ownership

[`core.ts`](../extensions/core.ts) unconditionally owns the channel and the sole
headless hold/shutdown wait. Notifications use cpi's existing renderer and
`external-event` kind, with steering and `triggerTurn`. Payload keys are fixed;
producer data is an escaped JSON string in `<data>`, never raw XML. Read JSON
only after XML decoding. Summary and source are escaped separately.

The bridge tracks submitted notifications until pi emits their `message_start`.
This matters because `ctx.hasPendingMessages()` tracks user input, not custom
notifications, and a wake signal alone is edge-triggered. The queue predicate is
checked before acquiring the hold and during it; a notification arriving just
before `agent_end` cannot get stranded behind that hold. A notification already
consumed during an active turn does not leave a spurious wake for the next wait.

Only the producer's session scope can wake its hold. Reload, replacement, abort,
and disposal invalidate observers/handles. Passive subscriptions by themselves
are legitimate waits and do not arm the anti-stuck agent resumption. Shell and
alarm policies remain separate. Pending subscriptions defer goal evaluation;
queued events run before goal evaluation.

Run the real pi runtime regression tests with:

```sh
bun test extensions/lib/external-events.integration.test.ts extensions/lib/session-hold.integration.test.ts
```

The tests replay finite assistant responses into the real Agent/AgentSession,
load the actual core and `wait_any` extensions, and synchronize on events and
hold state; no provider request or business operation is made.
