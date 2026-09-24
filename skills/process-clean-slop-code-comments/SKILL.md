---
name: process-clean-slop-code-comments
description:
  Use when pruning or validating a docstring or comment block — verifies which
  of its claims are recoverable from code alone by deleting the block and
  blind-probing a subagent, so only non-derivable facts survive. Enumerates
  every docstring and comment block, then probes the chosen one; python
  docstrings and comment runs across 13 tree-sitter languages (python, ts/js,
  go, rust, c/cpp/cuda, zig, bash, toml, yaml). Search terms — comment probe,
  docstring pruning, slop comments, blind probe, recoverable from code.
---

# Comment Probe

Validates that a comment block earns its place: strip it, ask a fresh subagent
questions the block would have answered, and keep only the facts the subagent
could not recover from code. Tree-sitter parsed (cpi's wasm build); python
docstrings, comment runs everywhere else.

The probe subagent never loads this skill. Its task must be fully self-contained
in the heredoc.
cpi sets `CPI_HARNESS_SRC` to this package's installed root; use it rather than
assuming a separate `~/cpi` checkout.

## Steps

Run in order; never leave a file stripped.

1. **Extract.** Enumerate every extractable block — each line shows its span,
   kind, the `--target` that addresses it (dotted def names for docstrings, def
   names for doc comments), and a preview:

   ```sh
   "$CPI_HARNESS_SRC/skills/process-clean-slop-code-comments/scripts/probe" list FILE [--lang L]
   ```

   Then `show` the block under test — every target printed by `list` works
   verbatim:

   ```sh
   "$CPI_HARNESS_SRC/skills/process-clean-slop-code-comments/scripts/probe" show FILE [--target T] [--lang L]
   ```

   Targets: `module` (default), a dotted def path (`Widget.render`) for
   docstrings, a def name for doc comments, or `comment:<text>` for a comment
   run — any substring unique to the run; it selects the first standalone
   comment line containing it and expands to the whole run (trailing comments
   are never matched). Dotted def paths resolve through nesting
   (`Widget.render`); def targets in non-python languages take the comment run
   immediately above the declaration. Language comes from the file extension,
   overridable with `--lang`.

2. **Question.** Turn every claim in the block into one question. Phrase
   questions so they do not leak the answer; ask "why" for every
   rationale/design claim; add a caveats question ("anything a caller must
   know") — probes reliably over-deliver there.

3. **Strip.**

   ```sh
   "$CPI_HARNESS_SRC/skills/process-clean-slop-code-comments/scripts/probe" strip FILE [--target T] [--lang L]
   ```

   Backs up to `FILE.probe-bak`; refuses while a backup exists — a leftover
   backup means a prior run never restored: run step 5, then retry.

4. **Probe.** Launch a fresh subagent (new session id every run — resuming a
   prior probe contaminates it). Model is configurable; default
   `meshy-sglang/zai-org/GLM-5.3-Flash:high`, the workhorse pick from
   `subagent-models.md`. Prompt on stdin via quoted heredoc, never as a
   positional argument; do not detach the launcher:

   ```sh
   subagent -m "${MODEL:-meshy-sglang/zai-org/GLM-5.3-Flash:high}" -s <unique-id> <<'TASK'
   You are probing a source file whose <docstring|comment block> was
   deliberately removed. Answer the questions below PURELY from the remaining
   code, signatures, comments, tests, and callers. Do NOT rely on the removed
   block (it is gone). Cite file:line evidence for every answer. If a question
   cannot be determined from code, say "NOT FINDABLE" and explain what is
   ambiguous.

   File: <absolute path> (repo root: <root>). Also inspect its callers/tests
   under the repo.

   Questions:
   1. ...

   Be terse but precise. End with a one-paragraph verdict: which facts were
   recoverable from code alone and which were only expressible in the removed
   block.
   TASK
   ```

5. **Restore & verify.**

   ```sh
   "$CPI_HARNESS_SRC/skills/process-clean-slop-code-comments/scripts/probe" restore FILE
   ```

   Prints `RESTORED`.

6. **Prune.** Delete every sentence the probe recovered with line-cited
   evidence. Keep only facts marked `NOT FINDABLE` or recoverable only obliquely
   (scattered comments in other files, cross-referencing upstream conventions).
   Then loop: re-strip, re-probe, re-prune until a probe run recovers nothing
   the block uniquely carried (fixed point). If a kept fact has a silent-failure
   mode (e.g. checkpoint incompatibility), prefer defending it in code — an
   assert or a docstring at the point of use — over prose in a distant block.

## Boundaries

- Read-only in effect: the block is always restored; never commit a stripped
  file or a leftover `.probe-bak`.
- Does not rewrite prose for you — it decides what survives, you write it.
- Requires a tree-sitter-wasm build carrying `parse_lang` (zig 0.16+). The probe
  checks `CPI_TS_WASM`, then Pi's agent-directory shell-tools cache, then an
  optional `~/cpi/tree-sitter-wasm/zig-out/bin/` checkout build.
- Runtime: the `probe` wrapper execs the interpreter pi itself runs under
  (`CPI_RUNTIME_KIND`/`CPI_RUNTIME_BIN` — node, bun, or deno), falling back to
  `node` on PATH outside pi; node needs >= 23.6 for unflagged type stripping (22
  with `--experimental-strip-types`). `probe.mts` is the module it runs.
- Launcher mechanics (session ids, heredocs, model picks): see the
  `subagents-in-pi` skill.
