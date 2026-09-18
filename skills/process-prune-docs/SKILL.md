---
name: process-prune-docs
description:
  Use when tightening a markdown procedure, runbook, design, or spec doc —
  prunes sections or sentence parts, then blind-mocks the documented process
  with a subagent to check every critical point still lands; restores whatever
  the mock missed, so only load-bearing prose survives. Search terms — doc
  pruning, mock execution, load-bearing prose, procedure check, section pruning,
  tighten docs.
---

# Doc Prune Mock

The mock subagent runs with this skill unloaded and never sees the original doc;
its task must be fully self-contained in the heredoc.

## Steps

Run in order; never leave a file stripped.

1. **Enumerate.** Read the doc. Its headings and sentences are the blocks — rank
   them by likely prunability: examples that restate the rule; rationale with no
   decision hanging off it; steps repeating an earlier step's constraint;
   qualifiers ("usually", "generally") inside normative sentences; whole
   sections duplicating another section. Never rank by length alone.

2. **Prune.** Delete the section or sentence parts with your normal edit tools —
   one batch = one section, or several sentence parts of one section, small
   enough that a mock failure can be attributed.

3. **Mock.** Launch a fresh subagent (new session id every run) with this skill
   unloaded; prompt on stdin via quoted heredoc; do not detach:

   ```sh
   subagent --disable-skill process-prune-docs -m "${MODEL:-meshy-sglang/zai-org/GLM-5.3-Flash:high}" -s <unique-id> <<'TASK'
   You are handed a procedure document with some content deliberately removed.
   Execute the procedure ON PAPER: for each scenario below, write the exact
   actions you would take, in order, quoting the doc lines you rely on. Do not
   improvise from general knowledge — when the doc no longer answers, write
   "NOT SPECIFIED".

   File: <absolute path>

   Scenarios (together they must touch every step and every branch):
   1. Happy path: ...
   2. Branch: ...
   3. Edge or failure: ...

   End with a list of every point where you had to guess or wrote
   "NOT SPECIFIED".
   TASK
   ```

   The launcher aborts if `--disable-skill` names a skill the child did not
   load, so a launch that succeeds proves the mock never had this skill.

4. **Attribute.** Compare the mock's actions against the removed prose. A pruned
   point the mock skipped, got wrong, or reported as NOT SPECIFIED was
   load-bearing → restore (or re-add tighter). A point the mock handled without
   it → the prune stands. Scenarios that missed a branch are the orchestrator's
   fault: write better scenarios and re-mock before judging. Restore with
   `jj restore <paths>` or `git checkout -- <paths>`.

5. **Loop to fixed point.** Re-prune, re-mock until a pass removes nothing.
   Each batch builds on the standing prunes — restore the file after every
   mock, re-apply them, then cut the next candidate.
   Close with one full mock over the final doc using a scenario set covering
   every step and branch: zero NOT SPECIFIED on critical paths is the pass
   condition. A critical path is a point the executor must get right to run the
   process — an action, a branch condition, or a boundary rule; delegated
   mechanics and meta detail (counts, formats, sizes, which tool an action uses)
   are not. When a surviving point has a silent-failure mode, prefer encoding it
   in the procedure's own checklist over explanation prose.

## Boundaries

- Strip only VCS-tracked docs; the VCS state is the restore point. The doc is
  back in its pre-strip state after every mock, and a stripped state is never
  committed.
- Do not prune normative language (MUST / never / only / thresholds) unless a
  mock proves the sentence redundant with another.
- Mid-sentence cuts near dotted tokens (file extensions, versions) are easy to
  botch: prune whole sentences there.
- Preserve the doc's voice; re-add pruned survivors tighter, in the author's
  register, not the mock's.
- Launcher mechanics (session ids, heredocs, model picks): see the
  `subagents-in-pi` skill.
