# Audit process

This file is for the agent that runs a docs audit. It gives the procedure for
each phase. Read
[reader-oriented-docs-audit.md](../reader-oriented-docs-audit.md) first. In this
session you frame the audit, measure, assign auditors, consolidate the findings,
rewrite and verify. Run auditors and probers as read-only subagents with fresh
context. Launch them with `subagent`, and read the subagents-in-cpi skill for
the mechanics. They never inherit this conversation, never load the
prose-writing-editing skill, and never spawn subagents. Fresh context keeps
their findings independent of yours, and banning nested subagents bounds cost.
Wait for completion notifications. Polling wastes tokens and finds nothing
sooner.

In this file, `<skill-dir>` means the directory that holds
`scripts/doc-metrics.sh`.

## Contents

- [Phase 0: Frame](#phase-0-frame)
- [Phase 1: Measure](#phase-1-measure)
- [Phase 2: Derive questions](#phase-2-derive-questions)
- [Phase 3: Trace](#phase-3-trace)
- [Phase 4: Consolidate](#phase-4-consolidate)
- [Phase 5: Rewrite](#phase-5-rewrite)
- [Phase 6: Verify with blind probes](#phase-6-verify-with-blind-probes)
- [Phase 7: Re-measure and report](#phase-7-re-measure-and-report)
- [Failure handling](#failure-handling)

## Phase 0: Frame

Decide who the docs are for before you read them. Without a named reader you
cannot judge what to cut.

1. Classify the docs as repository docs, library README, agent skill, runbook,
   design guide or API reference, and choose criteria for that type. Repository
   docs must route readers to tasks. An agent must be able to act on a skill. A
   design guide must help readers decide consistently without prescribing every
   detail.
2. Name two to five reader types and their jobs, such as an evaluator, an
   operator, an integrator, a contributor or an agent applying a skill.
3. List where each reader starts: the root README, the docs index, `SKILL.md`,
   or a link from an error message.
4. List the sources of truth outside the docs: code, config, schemas, tests,
   build manifests and token files. Phase 3 records drift against them.
5. Decide which files are in scope. Set a skip-cost budget per question. The
   budget is the pages of unrelated content a reader may pass before the first
   answer. Unless the user says otherwise, require the first answer within one
   page of the entry point, or one link away, because a reader who must skim
   past more gives up or guesses.

Record this frame at the top of the report.

## Phase 1: Measure

```sh
bash <skill-dir>/scripts/doc-metrics.sh <files...>
```

With no arguments, the script measures the markdown files that `fd` finds under
the current directory, or else the tracked files from `git ls-files`.

Record each file's page count and each heading's page offset. Search for each
filename to find files with no inbound links. Check that index entries describe
their targets and that linked anchors match headings. Edit nothing until you
have recorded the baseline, because the after-numbers need something to compare
against.

## Phase 2: Derive questions

Build the question set with [deriving-questions.md](deriving-questions.md). Give
each question a reader, an entry point and a target section, which is the
document and section that should answer it. Record a question with no sensible
target section as a finding.

Present the question table to the user before you go further. Group it by
reader, show each question with its target section, and list anything you left
out of scope. Ask the user to add, remove or reword questions and to correct the
target sections. Then stop and wait. Do not trace, dispatch auditors or edit any
file until the user approves, because the user knows the readers and you do not.
Record the approved set in the report, and note which questions the user added
or changed.

Batch the approved questions by audience so each batch shares a path through the
docs. Use the batch sizes under "Scaling" in
[reader-oriented-docs-audit.md](../reader-oriented-docs-audit.md).

## Phase 3: Trace

Send one auditor per batch with a self-contained prompt. Launch each with
`subagent --disable-skill prose-writing-editing`, and pass the prompt on stdin
through a quoted heredoc, as step 4 of
[process-clean-slop-code-comments.md](../process-clean-slop-code-comments.md)
shows:

```text
You are auditing documentation in <doc set> from a reader's perspective.
Read-only: do not modify files or run commands that write.
Reader: <who>. Entry points: <paths>.
Questions:
1. <question>
…
Method: for each question, enter at an entry point and read the docs in the order this reader
would, top-down, following links only when a reader would. Measure sections with
`bash <skill-dir>/scripts/doc-metrics.sh <file>`.
For each question, record:
- status: answered | partial | missing
- path: entry point, then each section visited, with its page offset
- first answer: file:line; complete answer: file:line
- skip cost: pages of unrelated content passed before the first answer, naming each section
- duplication: other places stating the same fact, citing both sites
- drift risk: facts restated from an authority, citing the authority's file:line
- contradiction: places that disagree, citing both sites
- recommendation: delete | relocate | merge | rewrite | link | add
Cite file:line for every claim. Quote at most one short line per finding. If an answer is
absent, say "missing" and cite the closest passage. Never invent line numbers or page counts.
End with your top findings.
```

When the doc set is small, trace the questions yourself and keep the same row
format.

Discard any claim without a `file:line`, because nobody can check it. A row is
complete only when you fill every field in the auditor prompt or mark it "none".

## Phase 4: Consolidate

1. Merge the rows into one table per question.
2. Read every cited line before you accept a finding. Settle disagreements
   between auditors by re-reading, never by vote. A real disagreement between
   docs becomes a contradiction finding.
3. Assign each finding one action from the triage list in
   [writing-advice.md](writing-advice.md).
4. Rank contradictions and facts that duplicate an authoritative source first.
   Within each group, rank by reader cost, which is the skip pages you remove
   multiplied by how often that reader uses the docs. Measure the pages.
   Estimate the frequency from the Phase 0 frame and label it an estimate in the
   report.
5. Write the rewrite plan. Delete, relocate and merge before you rewrite, link
   or add, because rewriting text you later move is wasted work. Cite the
   question or finding that each change addresses.

## Phase 5: Rewrite

Apply the plan with [writing-advice.md](writing-advice.md). Make the moves
before the prose edits. Trace each change to a finding. Afterwards, update the
indexes, the tables of contents and every description that points at moved
content.

## Phase 6: Verify with blind probes

Send one prober per rewritten question, or per small group. Start each in a
fresh context with `subagent --disable-skill prose-writing-editing`, and pass
the prompt the same way as for auditors. Never tell a prober where the answer
is, because a hint turns the probe into a confirmation. A prober told to look in
`config.md` will find the answer there, whether or not a real reader would.

```text
Answer these questions using only the documentation in <doc set>, starting from
<entry points>. Read-only.
For each question: your answer in your own words; the files and sections you used, with
file:line; where you first found the answer; and how many lines or pages you read or skipped
before finding it. An approximate count is fine.
Then report anything confusing, contradictory, missing, too dense or too vague for the
intended reader. Cite both sites for contradictions.
```

Pass a question only when the prober answers correctly, finds the target section
and stays within the skip-cost budget. When a question fails, fix the doc and
re-probe with a new prober. After two failed fixes, revert that change and
report the question as unresolved, so the audit cannot loop forever. Treat the
critique section as new findings. Triage them, and return to Phase 5 if any is a
contradiction or a missing answer.

When a reader's route passes through a section you moved, probe the unchanged
questions on that route. Readers must still find those answers.

## Phase 7: Re-measure and report

Rerun `doc-metrics.sh` on the changed files. Report in this form:

```markdown
# Docs audit: <doc set>
## Frame
Readers, entry points, authorities, scope and budget.
## Question set
The approved questions, and which ones the user added or changed.
## Inventory
One row per file: pages before, pages after, key section offsets.
## Question traces
One entry per question: path, first answer, skip cost, status before and after.
## Findings, ranked
Each finding with file:line, action, reader cost, drift risk and outcome.
## Verification
One entry per probe: question, where the answer was found, skip cost, pass or
fail. Then each critique item and what happened to it.
## Declined or deferred
Findings you did not apply, with reasons.
```

## Failure handling

- If an auditor cannot answer within budget, record "missing" or "partial".
  Reject invented locations.
- If a batch stalls or errors, relaunch it. If it stalls twice, split it into
  smaller batches.
- If a prober finds the answer only after reading the wrong section and stays
  confused, record a skip-cost finding, not a pass.
- If a finding conflicts with the user's intent, follow the user and record the
  conflict under "Declined or deferred". Keep a section the user requested even
  when the audit recommends deleting it, because the user owns the doc's scope.
