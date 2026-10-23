# Audit process

This session handles framing, measurement, auditor assignments, findings, rewrites and verification. Auditors and probers are read-only subagents with fresh context. Use whatever subagent mechanism the harness provides. They must not
inherit this conversation, must not load this skill, and must not spawn their own children.
Wait for their completion notifications instead of polling.

## Phase 0: Frame

Decide who the docs are for before you read them closely.

1. Is it a repository's docs, a library README, an agent skill, a runbook, a design guide or an API reference? Choose criteria for the doc type. Repository
   docs route readers to tasks. A skill must be loadable and actionable by an agent. A design
   guide must help readers make consistent decisions without prescribing every detail.
2. Name two to five reader types and their jobs, such as an evaluator, an operator, an
   integrator, a contributor, an agent applying a skill, and so on.
3. List where each reader actually starts, such as the root README, the docs
   index, `SKILL.md`, a link from an error message.
4. List the non-doc sources of truth, such as code, config, schemas, tests,
   build manifests and token files. Phase 4 measures drift against these.
5. Decide which files are in and out, and the skip-cost budget per
   question. A good default is that the first answer arrives within one page of the entry
   point, or one link away.

Record this frame at the top of the report.

## Phase 1: Measure

```sh
bash <skill-dir>/scripts/doc-metrics.sh <files...>    # With no arguments, measures all markdown under the current directory.
```

Record each file's pages and each heading's page offset. Search for each filename to find
files with no inbound links. Check that index entries describe their targets and that linked
anchors match headings. Don't edit anything until you have recorded the baseline.

## Phase 2: Derive questions

Build the question set with [deriving-questions.md](deriving-questions.md). Each question
names its reader, its entry point and its intended home, meaning the document and section
that should answer it. A question that has no sensible home is already a finding.

Present the question table to the user before going further: the reader,
the question and the intended home, grouped by reader, plus anything you deliberately left out
of scope. Ask them to add, remove or reword questions, and to correct the intended homes. Then
stop and wait. Don't trace, dispatch auditors or edit any file until the user approves. Record
the approved set, and note which questions the user added or changed, in the report.

Batch the approved questions by audience so each batch shares a path through the docs.
Use the batch sizes in SKILL.md under "Scaling".

## Phase 3: Trace

Send one auditor per batch with a self-contained prompt:

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

When the doc set is small, trace the questions yourself, but keep the same row format.

Discard any claim that has no `file:line`. A row is complete only
when every field above is filled, or explicitly marked "none".

## Phase 4: Consolidate

1. Merge the rows into one table per question.
2. Read every cited line before you accept a finding. Settle disagreements between auditors
   by re-reading, never by vote. A real disagreement between docs becomes a contradiction
   finding.
3. Assign each finding one action from [writing-advice.md](writing-advice.md): delete,
   relocate, merge, rewrite, link or add.
4. Prioritize contradictions and facts that duplicate an authoritative source. Within each
   group, rank by reader cost. Multiply skip pages removed by how often that reader uses
   the docs. Measure the pages. Estimate reader frequency from the Phase 0 frame and mark
   it as an estimate in the report.
5. Write the rewrite plan. Delete, relocate and merge before you rewrite, link or add.
   Cite the question or finding that each change addresses.

## Phase 5: Rewrite

Apply the plan with [writing-advice.md](writing-advice.md), moves first. Keep each change traceable to a finding. Afterwards, update the indexes, tables
of contents and the descriptions that point at moved content.

## Phase 6: Verify with blind probes

Send one prober per rewritten question or small group, each with a fresh context and this
skill disabled. Never tell a prober where the answer is.

```text
Answer these questions using only the documentation in <doc set>, starting from
<entry points>. Read-only.
For each question: your answer in your own words; the files and sections you used, with
file:line; where you first found the answer; and how many lines or pages you read or skipped
before finding it. An approximate count is fine.
Then report anything confusing, contradictory, missing, too dense or too vague for the
intended reader. Cite both sites for contradictions.
```

A question passes when the prober answers correctly, finds the intended home, and stays
within the skip-cost budget. If it fails, fix the doc and re-probe with a new prober. After
two failed fixes, revert that change and report the question as unresolved. Treat the
critique section as new findings. Triage them and return to Phase 5 if any are serious.

Also probe a few unchanged questions whose paths cross moved sections. Check that readers
can still find those answers.

## Phase 7: Re-measure and report

Rerun `doc-metrics.sh` on the changed files. Report:

```markdown
# Docs audit: <doc set>
## Frame         readers, entry points, authorities, scope, budget
## Inventory     file | pages before | pages after | key section offsets
## Question traces   per question: path, first answer, skip cost, status before and after
## Findings, ranked  finding with file:line, action, reader cost, drift risk, outcome
## Verification  per probe: question, answer found at, skip cost, pass/fail; critique items and what happened to them
## Declined/deferred   findings not applied, with reasons
```

## Failure handling

- If an auditor can't answer within budget, record "missing" or "partial". Don't accept
  invented locations.
- If a batch stalls or errors, relaunch it. If it stalls twice, narrow it.
- If a prober finds the answer only after reading the wrong section and remains confused,
  record a skip-cost finding, not a pass.
- If a finding conflicts with the user's intent, follow the user's intent and record the
  conflict in "Declined". For example, keep a section the user requested even if the audit
  recommends deleting it.
