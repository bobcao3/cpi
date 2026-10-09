# cpi: Cheng Cao's agent harness

This repo hosts the cpi CLI, custom extensions, skills, and supporting tools for
our Pi fork. Development aims to materially improve harness performance. See the
[upstream Pi docs](https://pi.dev/docs/latest).

Manage this repo with **jujutsu (JJ)**, not blanket Git terminology like "commit".
JJ auto-tracks files into the current working "change"; there is no "creating a
commit". Iterate on changes like a stack; `jj evolog` shows their history. Split
mixed features into distinct layers with `jj split (files to split)...`.
Canonical remote: `origin` (forge.bc3.moe); local `github` is a secondary push target.

## Where to look

- Dev setup, PATH links, SDK: [CLI README](packages/cli/README.md).
- Fork startup, checks, tests: [Editable development](#editable-development).
- Publishing and artifacts: [Published packages](#published-packages).
- Docs, prompt text, source limits: [Coding rules](#coding-rules).
- Reproduction, research, confirmation: [Working and debugging](#working-and-debugging), [Verification](#verification).
- Test value: [Not writing useless tests](#not-writing-useless-tests).
- Design principles: [TigerStyle](#following-the-tigerstyle).
- Hot reload and host loading: [Developing extensions](#developing-extensions).

## Coding rules

Hard rules:

1. Each source file: at most 397 source-code lines (excluding whitespace and
   comments), 355 AST statements, and 7% comment lines. Comments are AST-counted by
   `packages/harness/scripts/comment-scan.mjs`, enforced via `bun lint`; format
   with `bun format`.
2. Never write file/module trees in docs: the filesystem is the tree and folder
   structure should explain itself.
3. All model-facing text (tool descriptions, prompt snippets, guidelines, schema
   field descriptions) belongs in `packages/harness/src/text/` as TOML templates
   loaded via `loadText`/`render`, never inlined in extension `.ts` source.
4. Docs must never repeat values or behavior encoded in default config or code;
   refer to that source of truth.

When refactoring, aim for at least 30%–50% AST-statement reduction, not line count.
Use the **simplest architecture**, not necessarily the fewest lines.

## Working and debugging

Pi core changes belong in the separate Pi fork. Harness development is iterative;
expect debugging. Make no accusations without consistent reproduction; fix no
bugs before nailing down the root cause. Prototypes are fine, but before submitting:

- Confirm the architecture addresses the issue permanently; otherwise it is wrong.
- Analyze all potential side effects and test every impact, even intended ones.

For "industry standard", "latest", or "what tool should we use" questions, always
research online for first-hand, up-to-date information.

### Editable development

`npm run prepare:fork` clones the git-ignored `.pi-fork/` via `jj git clone`;
`CPI_FORK_REMOTE` overrides the remote. `install:dev` runs preparation after
installing dependencies; `scripts/dev.mjs` runs it on demand.

Run `node scripts/dev.mjs` against that fork, or set `CPI_FORK=/path/to/fork` for
another checkout. The CLI resolves fork TypeScript sources directly. Source
checkouts auto-discover `.pi-fork/`; published installs and source checkouts
without it use pinned artifacts.

Use the same fork for development checks and integration scripts:
`node scripts/check.mjs` auto-selects `.pi-fork/` when present; `CPI_FORK` overrides
it. Bun tests also need the selected fork's `tsconfig.json` passed through
`--tsconfig-override` to resolve imports against that checkout.

Normal edit/test work needs no builds, dependency reinstallation, artifact
installation, temporary installed copy, or publication. Perform
[initial PATH/link setup](packages/cli/README.md#editable-development-install)
only when needed or requested. Format maintained application/tool source, not
historical docs or benchmarks.

### Published packages

After pushing package changes, verify an independent installed-package layout
without local Pi peers. Development verification does not replace this check.
Published packages use the versioned artifacts in `vendor/pi/manifest.json`;
update artifacts and dependency pins with the
[artifact importer](packages/cli/scripts/import-pi.mjs), using durable release
assets, not expiring CI downloads. Never commit package archives or replace
published dependencies with source links. See
[registry release](packages/cli/registry-release.md) for publication checks.
Publishing is a separate authorized operation.

## Verification

"Work done?" means confirmed: user-requested implementation implies real-world verification.
Do not return a solution before confirming it works in the real world.

## Not writing useless tests

Do not write tests for their own sake. If you wrote a test, think again: is it
trivial, and is it actually testing the production path? No mocking; prefer
comprehensive integration coverage over exhaustive mock tests.

# Following the [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md)

## 1. Safety

Correctness is necessary but insufficient: use defense-in-depth and runtime
self-verification; run correctly or shut down when expectations are violated.
TigerStyle follows Gerard J. Holzmann's NASA Power of Ten Rules for Safety-Critical
Code (static allocation, assertions, explicit limits). Read the Original Rules.

### Explicit Limits

Everything has a limit: bound resources, concurrency, execution, loops, and queues
to detect infinite loops and latency spikes. Schedule work at fixed intervals
rather than reacting to stimuli. Avoid recursion.

### Assertions

Types check structure; assertions check logic and state to detect programmer
errors, multiply fuzzing, and downgrade catastrophe. Assert arguments, returns,
and invariants: expected and unexpected states, positive and negative space,
contract and breach.

### Logical Interfaces

Interfaces dominate safety, performance, and experience. Minimize surface area,
define fault models, abstract nondeterministic physical interfaces behind
deterministic logical ones, and push control flow up and data flow down.

### Dimensionality

Simplify signatures to reduce call-site branches that spread through the call
graph. Prefer return types `bool` over `u64` over `!u64`. Minimize variables or
define them near use to close semantic gaps in time and space.

### Minimize Dependencies

Minimize dependencies: safety, performance, supply-chain, and installation costs
multiply for infrastructure. Tools also cost; a small standard toolbox may feel
slow initially but accelerates the team over time.

### Zero Technical Debt

Do it right the first time, while code is hot like steel: another chance may not
come. Quality builds momentum and sound foundations enable steady progress.

## 2. Performance

### Zero Copy / Deserialization

Per-core memory bandwidth is a new bottleneck. Work directly; do not copy data-plane
memory, thrash the CPU cache, serialize, or deserialize. Use fixed-size,
cache-line-aligned structs; align structs to their largest field.

## 3. Experience

A day of design saves weeks or months in production: go slow to go fast. Optimize
total ownership cost for repeated readers and operators, not one-time authors.
Trade linear deadlines for exponential quality.

### Simplicity And Elegance

Edsger Dijkstra: simple, elegant systems are easier and faster to design correctly,
more efficient, and more reliable, but demand hard work and discipline.

### Nouns And Verbs

Great names are the essence of great code: capture what a thing is or does for a
crisp mental model. Append qualifiers; sort by most significant word (big endian
naming); use equal character counts for related names (e.g. source/target) to align
them in source; use snake_case; don't abbreviate.

---

# Developing extensions

## Pi peer packages are not worker dependencies

`pi install git:...` loads extensions through Pi, but native Node workers and
scripts resolve imports from cpi's installed directory, where Pi peers may be
absent. Never rely on cpi's local `node_modules` Pi peers at runtime. Workers and
standalone entry points must avoid bare runtime Pi peer imports and load the
**active host Pi** through
[`packages/harness/bin/host-pi.mjs`](packages/harness/bin/host-pi.mjs).
Type-only imports are fine. Use the editable active host during development
and the independent installed host for publication verification.

## Hot reload: registrations versus shared state

Pi loads extensions through jiti with `moduleCache: false` and can hot-reload
one file mid-session. Instance registrations (`extension.messageRenderers`,
`extension.handlers`) use fresh `new Map()` storage on every load; reload discards
the old instance and its maps, leaving the new instance empty.
`globalThis` persists across reloads and is shared by module copies in the process.

Never guard per-instance registration with a persistent `globalThis` dedup flag:

```ts
// WRONG — reload keeps DONE but discards the renderer registration.
function ensureThing(pi) {
  const g = globalThis as Record<string, unknown>;
  if (g.DONE) return;
  pi.registerMessageRenderer(...);
  g.DONE = true;
}
```

After reload, this skips registration on the empty new instance, silently causing
Pi's default `[customType]` + raw-content fallback rendering or undrained queues.
It broke `ensureNotificationRenderer`, `ensureDrains` (prepend-message), and
`ensureRenderer` (cwd).

Use these patterns:

- **Queryable resources:** guard on real state, not a boolean: `if (timer) return`
  (`lib/footer.ts`), `existsSync(bin)` (`shell/tools.ts`), or re-merge state per call
  (`cwd.ensureToolActive`).
- **Unqueryable per-instance registration:** give shared plumbing one owner in
  `packages/harness/src/core.ts`; producers are pure clients and never register.
  Its owners cover footer, notification renderer, prepend-message drains,
  system-prompt transforms, and session-hold. Co-location ensures plumbing exists
  iff cpi does, prevents dangling producers, and re-registers all owners atomically
  on core reload. Register unconditionally at load and re-register on the owner's
  own reload, with no `globalThis` flag.
  `pi.registerMessageRenderer` / `pi.on` use `Map.set` / append on the fresh instance;
  once per load is idempotent. Unconditional registration at load is also fine
  only for a sole-owner extension; multiple owners double-register, so use a
  dedicated owner for shared features.
- **Shared mutable data:** `globalThis` is fine for state re-read on every call and
  repopulated on reload: the footer singleton (`lib/footer.ts`), transcript renderer
  registry (`lib/transcript-registry.ts`), and prepend-message queues. Never use it
  to skip registration. If an `ensure*` uses a global boolean, check real resource
  state instead or move registration to a dedicated owner.

## `registerSystemPromptTransform` — dynamic behavior only

`registerSystemPromptTransform` (`lib/system-prompt.ts`) rewrites the system prompt
every turn. Use it sparingly, only for changing runtime state that must reach the
agent for correctness or effectiveness. Static reference text (command cheat-sheets,
descriptions, fixed docs) belongs in tool `description`/`promptGuidelines`, rendered
once at registration, not re-stapled each turn. Unchanging content is tool text,
not a transform.
