# cpi: There are many agent harnesses,but this one is Cheng Cao's.

This is the cpi repo which hosts custom extensions & skills for [pi-agent](https://pi.dev/docs/latest)

Developing this repo means we want to materially improve the performance of the agent harness.

This repo should be managed by `jujutsu VCS` (i.e. JJ).

- Avoid using blanket `git` terminology like "commit"
- JJ auto-tracks changes to files, there is no "creating a commit", everything stacks into the current working "change"
- If a change gets polluted with multiple features, use `jj split (files to split)...` to split off into distinct change layers
- We can keep iterate on a change (treat each change kinda as a git-stack), `jj evolog` shows history of changes
- The remote storage is GitHub (thus still Git)

## Coding rules

Hard rules:

1. No source code file exceeds 397 sourcecode lines (ignore whitespaces and comments).
2. No source code file exceeds 355 AST statements.

Guideline: When refactoring, aim for at least 30%-50% AST statements reduction (instead of line count).

Principal: Use the **simplest architecture**, not necessarily solution with least lines of code

## Working and debugging

Developing an agent harness is iterative. Debugging is expected.

No accusations shall be made without a consistent reproduction.

No bugs shall be fixed without nailing down the root cause.

Find the correct architecture. You can prototype a fix, but before submitting your work, think twice:

- Is my fix going to address this issue permanently? If not: not the correct architecture.
- Is my fix going to cause side effects? If yes: side effects can be correct, but we need complete analysis of potential impact, and no impacts shall be left untested.

## Verification

"Work done?" -> Have you confirmed it?

When user asks for an implementation task, verfication in real world is implied. Do not return a solution without confirming it works in real world.

## Not writing useless tests

Do not write tests for the sake of writing tests.

If you wrote a test, think again, is this trivial, is this actually testing production path? No mocking, mocking is mere mockery.

Prefer achiving coverage through comprehensive integration, not exhaustive testing through mocking.

# Following the [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md)

## 1. Safety

**Correctness is necessary but not sufficient for safety.**

To be safe, a program must not only run correctly. It must apply defense-in-depth and verify itself while running, to run correctly or else shut down if it detects that it has violated expectations.

TigerStyle follows the spirit of NASA's Power of Ten Rules for Safety-Critical Code by Gerard J. Holzmann. For example, static allocation, assertions and explicit limits. Read the Original Rules, which will change the way you code forever.

### Explicit Limits

Put a limit on everything because everything has a limit.

Bound all resources, concurrency, and execution. Don’t react to stimuli but use fixed intervals to schedule work. Avoid recursion. Bound loops and queues to detect infinite loops and latency spikes.

### Assertions

Where types check structure, assertions check all logic and state, to detect programmer error, multiply fuzzing, and downgrade catastrophe. Assert arguments, returns, and invariants: what you expect and don't expect, the positive and negative space, not only contract but breach.

### Logical Interfaces

The safety (as well as performance and experience) of a system is dominated by the quality of its interfaces.

- Minimize surface area
- Define fault models
- Abstract physical non-deterministic interfaces with logical deterministic interfaces
- Push control flow up and data flow down

### Dimensionality

Simplify function signatures to minimize branches at the call site, which are viral through the call graph.

As a return type, bool trumps u64 trumps !u64.

Minimize or define variables near to when/where they are used, to close semantic gaps in time/space.

### Minimize Dependencies

Dependencies risk safety and performance, invite supply chain attacks, and increase install times. For infrastructure in particular, these costs multiply up the stack.

Similarly, tools have costs. A small standard toolbox feels slow for you at first but accelerates the team long term.

### Zero Technical Debt

Code, like steel, is easier to change while it's hot. Do it right the first time, the best you know how, because you may not get another chance, and because quality builds momentum. This is the only way to make steady progress, knowing that the foundations are solid.

## 2. Performance

### Zero Copy / Deserialization

Per core memory bandwidth is a new bottleneck:

- Do things in the most direct way possible
- Don't copy memory in the data plane
- Don't thrash the CPU cache
- Don't serialize or deserialize data
- Use fixed-size cache line aligned structs
- Align structs to their largest field

## 3. Experience

A day of design is worth weeks or months in production. Therefore, go slow to go fast. Optimize the total cost of software ownership, not for those who write it once, but for those who read and run it many times. Trade linear deadlines for exponential quality.

### Simplicity And Elegance

"...simple and elegant systems tend to be easier and faster to design and get right, more efficient in execution, and much more reliable, **but** require hard work and discipline to achieve..."

— Edsger Dijkstra

### Nouns And Verbs

Great names are the essence of great code, capturing what a thing is or does, for a crisp mental model.

- Append qualifiers to names
- Sort by most significant word (big endian naming)
- Use the same number of characters for related names (e.g. source/target) so they line up in the source.
- Use snake_case
- Don't abbreviate

---


# Developing extensions

cpi extensions run inside pi, which loads each via jiti with `moduleCache: false`
and can hot-reload a single extension file mid-session. Two facts shape every
extension design decision:

1. **Per-instance registration is transient.** pi stores message renderers and
   event handlers on the *extension instance* (`extension.messageRenderers`,
   `extension.handlers` — a fresh `new Map()` on every load). On a hot-reload,
   the old instance (and its Map) is discarded; the new instance starts empty.
2. **`globalThis` is persistent.** It survives jiti reloads and is shared across
   all extension module copies in the process.

## Anti-pattern: a `globalThis` "done" flag guarding per-instance registration

```ts
// WRONG — breaks on reload
function ensureThing(pi) {
  const g = globalThis as Record<string, unknown>;
  if (g.DONE) return;        // flag persists across reload...
  pi.registerMessageRenderer(...);  // ...but this Map entry does not
  g.DONE = true;
}
```

**Why it's bad.** The flag says "already done" forever; the renderer/handler it
guards lives only on the instance that registered it. After a hot-reload, the
flag is still `true` so re-registration is **skipped**, but the new instance's
Map is empty. Result: the feature silently breaks — pi falls back to the
default `[customType]` + raw-content render, or queued messages never drain.
This is not theoretical: it bit `ensureNotificationRenderer`,
`ensureDrains` (prepend-message), and `ensureRenderer` (cwd).

## Sound patterns

- **Guard on real resource state, not a boolean flag.** Check the thing itself:
  `if (timer) return` (`lib/footer.ts`), `existsSync(bin)`
  (`shell/tools.ts`), re-merge state per call (`cwd.ensureToolActive`).
- **Own per-instance registration in one core extension.** When registration
  has no queryable state (a renderer, a drain handler, a system-prompt
  transform owner, session-hold), it is registered unconditionally at load and
  re-registered on its own reload. Producers are pure clients — they never
  register. All such owners live together in `extensions/core.ts` (footer,
  notification renderer, prepend-message drains, system-prompt transforms,
  session-hold): one extension means the shared plumbing is present iff cpi is
  present at all — no producer can be left dangling without its owner, and a
  single hot-reload re-registers every owner atomically. Each registers
  unconditionally at load (no `globalThis` dedup flag); `pi.registerMessageRenderer`
  / `pi.on` are idempotent `Map.set` / append on the fresh instance.
- **Unconditional register at load when the extension is the sole owner.**
  `pi.registerMessageRenderer` / `pi.on` are idempotent `Map.set` / append;
  calling once per load is fine. Use this only when one extension owns the
  feature (else multiple owners double-register; prefer a dedicated owner for
  shared plumbing).

## `globalThis` is fine for shared *state*, not for dedup *flags*

`globalThis` is correct when it holds **shared mutable state** re-read on every
call — e.g. the footer singleton (`lib/footer.ts`), the transcript renderer
registry (`lib/transcript-registry.ts`), the prepend-message queues. That state
is *data*; reloads re-populate it and it is never used to skip registration.
The anti-pattern is specifically a **boolean dedup flag** gating registration on
**transient per-instance** state. If you find yourself writing `ensure*` with a
`globalThis` boolean, stop: either check real state, or move registration into a
dedicated owner extension.
