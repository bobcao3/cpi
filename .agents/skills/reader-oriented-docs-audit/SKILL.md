---
name: reader-oriented-docs-audit
description:
  Use when auditing, reviewing, or rewriting cpi documentation (root README,
  docs/, package READMEs, AGENTS.md, skills) from a reader's point of view —
  supplies 50 reader questions covering the cpi harness extensions and the Pi
  fork, traces read and navigation paths with 80x24 page skip costs, fans out
  read-only subagent audits, and applies concise, drift-resistant writing
  advice. Search terms — docs audit, README review, reader questions, skip
  cost, documentation rewrite, doc drift, duplicated docs.
---

# Reader-oriented docs audit

Audit cpi docs the way a reader walks them: inventory, question traces,
fan-out subagent audits, ranked findings, rewrite, blind verification.

Scope: the cpi checkout (root `README.md`, `AGENTS.md`, `docs/`, package
`README.md` files, `skills/`) and, for questions that target Pi core, the fork
docs in the sibling `cpi-fork` checkout or the pinned copy under
`$PI_AGENT_SRC/docs/`. Supporting pieces: `references/questions.md` holds the
50 reader questions and the home each answer should have;
`references/audit-process.md` holds the fan-out protocol, evidence contract,
report shape, and blind verification; `references/writing-advice.md` holds the
one-home rule, the cpi source-of-truth table, and the review checklist;
`scripts/doc-metrics.mjs` measures pages (one page is one 80x24 terminal
screen; long lines fold, blank lines count) and heading offsets.

## Procedure

1. **Inventory and measure.** From the repository root, run
   `node .agents/skills/reader-oriented-docs-audit/scripts/doc-metrics.mjs <files>`
   over the docs in scope, or with no arguments to discover repository
   markdown. Record per-file pages and per-section offsets.
2. **Scope.** Select question groups from `references/questions.md` and adapt
   names and paths to the docs under audit. The question list is an audit
   instrument that drives narrative structure — never publish it as an FAQ.
3. **Fan out.** One subagent per group of five to eight questions, following
   `references/audit-process.md`. Subagents are read-only and never spawn
   children; launcher mechanics belong to the `subagents-in-pi` skill.
4. **Consolidate.** Merge findings, read every cited line before accepting it,
   then rank by skip pages removed and by drift risk.
5. **Rewrite.** Apply `references/writing-advice.md` in its triage order:
   delete, relocate, merge, rewrite, link, add. Move sections before editing
   prose, because moves remove the most skip cost per edit.
6. **Verify.** Blind-probe every rewritten question with a fresh subagent
   launched with `--disable-skill reader-oriented-docs-audit`. The prober must
   answer from the docs alone and report where the answer was found and how
   much it skipped. A rewrite that fails its probe is reverted or fixed, never
   kept on faith.
7. **Re-measure.** Rerun `scripts/doc-metrics.mjs` on changed docs and report
   before and after skip costs.

## Rules

- Every finding carries `file:line` evidence; read the cited lines, never
  count or edit without reading them.
- Triage findings instead of applying them wholesale: content is often in the
  wrong place rather than worthless.
- Docs never restate values encoded in code, config, tests, or generated
  files. cpi's authorities: tool text in `extensions/text/*.toml`, tunables in
  `cpi-config.default.json`, pins in `vendor/pi/manifest.json`, rules in
  `AGENTS.md`. See the one-home rule in `references/writing-advice.md`.
- Never write a file tree into a doc; the filesystem is the tree.
- Keep delegation one level deep; audit and verify subagents never spawn
  children.
