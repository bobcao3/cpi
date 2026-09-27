---
name: test-audit
description:
  "Use when writing, changing, reviewing, or pruning tests in any codebase.
  A checklist for new tests, plus an audit workflow for low-value,
  implementation-coupled, or duplicative tests and the test-only production
  changes they require."
---

# Test Audit

Three modes, one standard: every test must earn its maintenance cost. First
mode: new tests are checked at write time. Audit mode: focused sweeps remove tests
that re-assert source, duplicate stronger proof, couple behavior
to implementation, or keep test-only production hooks alive. Sweep mode prunes
one whole subsystem's test surface
(e.g. one web app area, GPU package, or model pipeline); if the repo defines a
sweep protocol, read it before starting one. In all modes optimize for
confidence, invariant enforcement, and maintenance cost — not raw deletion
count.

## Before adding a test

Before adding any test, answer four questions; a missing answer means do not add
it yet:

1. What observable behavior, invariant, or independent contract does it protect?
   Examples: API behavior, storage semantics, data-layout invariants, ordering
   guarantees, resource lifecycles. Scoped contracts live in the sections below: web
   applications, GPU/graphics code, ML/numerical code.
2. What credible regression makes it fail? Examples: broken route or auth check,
   silent data transposition, off-by-one offset, sign inversion at a boundary,
   deadlock or race masked by an accidental sync, precision underflow under
   low-precision scaling. Canonical per-domain regressions are listed in the
   scoped sections below.
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test at the strongest level (e.g. low-level parity tests
   vs. end-to-end pipeline integration; unit vs. transport/lifecycle boundary).
   Another layer needs its own distinct risk the primary test cannot reach. Prefer
   extending a parameterized or table-driven case over a near-duplicate test
   function, and consolidate duplicated setup in the same change.
4. Does it need a test-only change to production code (export, flag, wrapper,
   hook, debug bypass) that no production caller needs? If yes, move the test to
   the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails this
checklist unless [what to keep](#what-to-keep) names the contract it
independently guards. A test that breaks under behavior-preserving refactoring
asserts implementation, not behavior; rewrite it at the right level before
merging it.

Bug regression tests must demonstrably fail on the pre-fix code for the intended
reason and pass after the fix. A regression test that never
demonstrably failed proves the mock, not the fix. One regression test at the level
closest to the bug covers it; do not replay the same scenario at every layer it
crosses.

## Junk patterns

Shared checklist for both modes: don't add a new test that matches one; audits
remove existing tests that do.

- **Tests without assertions:** invoking a handler, pipeline step, or
  kernel launch without checking shapes, status, state, dtypes, finite values,
  or boundary invariants.
- **Self-comparisons and copied logic:** asserting `x == x`, identity
  copies, expected values produced by the system under test, or a
  re-implementation of the same logic (same index arithmetic, same query
  expression) written by the same author in both `src` and `test`.
- **Copied lists and config restatements:** asserting a
  manifest, export list, or `cfg.dim == 512` right after constructing it;
  testing that a declaration exists instead of exercising the behavior it
  promises.
- **Exact source, import, stdout, log, or repr greps:** asserting log strings,
  progress bars, or summary text instead of state, values, or metrics — unless
  the exact bytes are the shipped contract (see what to keep).
- **Internals re-tested at the public boundary:**
  unit-testing internals whose behavior is already proven at the public API,
  transport, or pipeline boundary without introducing a distinct layer risk.
- **Multi-layer replays of the same contract:** verifying identical arithmetic
  or logic in isolation and again across bindings, loaders, and eval scripts (or
  across unit, route, and e2e) without a new per-layer risk.
- **Duplicated coverage per plugin or backend:** re-testing shared
  behavior once per plugin, backend, or dtype without plugin-specific risk.
- **Over-mocked tests:** mocking out the exercised layer or its I/O to verify
  mock call counts rather than real transformations, layouts, or states; one
  identical mock standing in for different APIs; mocks that implement the
  asserted behavior.
- **Mocked device execution [when testing GPU / graphics code]:** replacing
  streams, collectives, or kernel launches with mocks to verify call counts
  instead of memory layouts, stream ordering, or device states.
- **Fixtures that do the code's job:** fixtures supplying the result, ordering,
  or golden output the code under test should
  produce; persistence asserted against a store the path never writes.
- **Symmetric synthetic data masking bugs [when testing ML / numerical code]:**
  square inputs, equal dimensions (`M=N=K`), or cubic grids where
  transpositions, axis swaps, or row/column-major confusions silently pass.
  Always test with asymmetric, non-square dimensions.
- **Single-variant fixtures [when testing web applications / services]:**
  exercising only one locale, encoding, or input variant where ordering,
  formatting, or boundary bugs silently pass; always mix variants.
- **Over-wide timing or fuzzy-status assertions [when testing web applications /
  services]:** time-window or status matchers loose enough to mask broken
  behavior.
- **Unbounded numerical tolerances [when testing ML / numerical code]:** loose
  `atol`/`rtol` masking broken projections, precision truncation, or silent
  low-precision fallbacks.
- **Hidden sync traps [when testing GPU / graphics code]:** tests claiming async
  or concurrent behavior that serialize before the work finishes (host readback,
  device-to-host copy, eager equality, logging device values, or awaiting what
  the test itself forced to complete), masking races.
- **Magic-number struct/size assertions:** hardcoded byte sizes or snapshot
  integers instead of compiler, reflection, or roundtrip checks.
- **Brittle snapshot overfitting:** multi-megabyte binary dumps or golden files
  where benign float reordering or toolchain updates cause spurious failures;
  prefer semantic or roundtrip assertions.
- **Tests that only protect test-only hooks:** tests whose only purpose is keeping dead
  flags (`is_test=True`), debug wrappers, or export hooks alive; dead production
  code whose only callers are tests. Delete the hook with the test.
- **Negative controls that pass for unrelated reasons:** expected rejections
  that pass because of a different guard, uninitialized hardware, resource
  exhaustion, or a path production never reaches.
- **Names or fixtures promising more than the input exercises:** e.g. a "retires
  the window" test [web] that never clears it, or a "concurrent streams" test
  [gpu] that runs serially.

## What every test must prove

Tests justify their maintenance cost by protecting observable behavior, a
credible regression, or an independently meaningful contract. Runtime errors in
hot paths indicate architectural weakness; prefer end-to-end proof, explicit
production assertions, and per-stage checks over trivial unit clutter.

Before judging a test, read the complete test and the production code:
entry point, callers, callees, sibling implementations, overlapping tests, CI
 routing, and relevant history. Read root and scoped guide files first (e.g.
`AGENTS.md` and package guides). When the test claims dependency-backed
behavior, inspect the dependency source or types directly. An existing test that
must change under behavior-preserving reorganization is suspect, not
automatically deletable; still don't add new tests that match.

### When testing web applications / services

Ownership, API, and lifecycle boundaries: public API and plugin behavior,
protocol and serialization formats, config and migration semantics, storage
roundtrips, auth/security enforcement, call ordering where order is observable,
and defaults or generated artifacts where bytes cross a boundary.

### When testing ML / numerical code

- **Layout and memory invariants:** shape, dtype, device, strides, contiguous
  layout; asymmetric dimensions to expose permutations; valid offsets, ragged
  slicing, index bounds, and padding boundaries.
- **Coordinate conventions:** independently assert conversions at boundaries
  (e.g. surface axis order vs. stored-field index order); never permit axis
  swaps to pass silently.
- **Independent references:** verify numerics with basic, transparent primitives
  (explicit indexing/reshape, plain host reference), not by repeating the fused
  or dispatched expression under test.

### When testing GPU / graphics code

- **Synchronization discipline:** production paths must not gain hidden
  host-device syncs (host readback, device-to-host copy, boolean coercion of
  device values, eager equality, logging device scalars) without approval. In
  tests, host syncs belong only at the final assertion boundary. Prefer ordered
  waits and events over host-side synchronize; never launch on the default
  stream when concurrent streams are active; never guard device work with host
  mutexes. Audit device paths with sync-debug warnings or execution traces where
  available.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel lanes when available and adapt them to the repo layout, for
example:

- web applications, services, and UI;
- core libraries and packages, including accelerator and GPU packages;
- plugins and extensions;
- models, datasets, data pipelines, and training workspaces;
- a cross-cutting pattern sweep.

Outside sweep mode, prefer a few clear-cut cases over a large
speculative inventory. Hunt specifically for tautologies, mock-heavy stubs,
symmetric fixtures, loose tolerances, duplicated contracts, and dead hooks.

## What to keep

Keep a test when it independently enforces a public API, plugin, protocol,
config, migration, storage, security, platform, default, packaging, release, or architecture contract. Also keep:

- **[ML / numerical code]** layout and coordinate contracts as defined above;
  host-vs-device numerical parity within tight, explicit tolerances against an
  independent reference; gradient contracts (numerical-vs-analytical parity,
  update tracing, reduction semantics);
- **[GPU / graphics code]** memory, device, and stream lifecycles: descriptor
  layouts, barrier parity, deferred frees, multi-stream ordering;
- serialization and roundtrip fidelity: parsers, codecs, compression roundtrips;
- call ordering when order is observable behavior;
- verified regressions with a credible failure mode;
- text-match checks when they are the cheapest independent guard: it fails when the
  user-facing key, byte, or path changes and survives identifier-only refactors.

Don't remove a test just for being slow or needing special hardware. Partition slow or
accelerator-gated tests into the right tier (e.g. hardware-gated marks,
distributed marks, nightly lanes) rather than deleting them. A retained test
that fails on the baseline is a possible product bug: reproduce it and fix the code under test rather than deleting the test.

## Before deleting: record this

Record every item below before editing. A missing item means the test is not
ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production code or helper;
- stronger remaining test at the right level, or why no test is needed (e.g.
  guaranteed by production assertions or compiler typing);
- relevant history and the reason the test or hook exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Making the change

Change one related group of tests at the same level at a time. Delete obsolete test-only exports,
fixtures, globals, wrappers, and dead production paths instead of preserving
aliases. Move surviving regression tests to the level closest to the bug. Consolidate
repeated assertions into parameterized or table-driven cases.

Aim to remove more production code than you add. Do not add replacement tests that restate
the same implementation, and do not reframe uncertain cases as cleanup to inflate deletion counts.

## Validation

Never edit source or tests while runners, device jobs, or builds are executing
in the workspace. Activate the repo's environment first (whatever the project
uses) before running tests.

1. Run the smallest suites covering the change and their neighbors: the fast local tier (e.g.
   `pytest <path> -q`, `vitest <filter>`, `go test`, `zig test`) per repo
   convention.
2. Run hardware-gated tests through the repo's device path (e.g. accelerator
   partition, hardware-gated marks, distributed launchers); do not skip device
   runs for device-touched changes.
3. For device-touched changes, run with sync-debug warnings or inspect traces to
   confirm no unexpected host syncs.
4. Run the repo's formatter/linter on touched paths, then `diff --check`.
5. Run the repo's required checks for the touched paths.
6. Inspect the diff stat; report production simplifications separately from test
   and test-support churn.

## Merging the change

Commit, push, open a PR, or merge only when authorized. Follow the repo's VCS
conventions (linear history on `*/main` where required). Land one coherent batch
Merge one related batch at a time; refresh from main before beginning the next batch.

## What to report

Report:

- root cause and removed low-value categories;
- production-code and hook simplifications;
- retained false positives and why they remain valuable;
- tests actually run, focused and full (unit, device, sync audit);
- production vs. test lines changed;
- working copy and VCS/PR state;
- named follow-ups.
