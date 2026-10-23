---
name: reader-oriented-docs-audit
description: Use for documentation audits, README or skill reviews, rewrites, and checks for drift or duplication. Derive reader questions, measure how much unrelated text readers skip, check each fact against its authoritative source, and verify rewrites with blind probes.
---

# Reader-oriented docs audit

Use this process to find missing answers, answers buried under unrelated material, and facts copied from other sources. Derive questions for the docs and their readers, then measure, rewrite and verify the answers.

## Phases

| # | Phase | Output | Exit when |
|---|---|---|---|
| 0 | Frame | readers, jobs, entry points, and scope | every doc in scope has a named reader |
| 1 | Measure | doc map with page counts and section offsets | baseline numbers are recorded |
| 2 | Derive questions | question set, each with an intended home | every reader job is covered and the user has approved the set |
| 3 | Trace | per-question evidence rows, fanned out to auditors | every row meets the evidence contract |
| 4 | Consolidate | ranked findings, each with one triage verb | every cited line has been re-read |
| 5 | Rewrite | edited docs | every finding is applied, declined with a reason, or deferred |
| 6 | Verify | blind-probe log | every rewritten question passes |
| 7 | Re-measure and report | before/after table and report | the user has the report |

Follow the phases in [references/process.md](references/process.md). Build the question set with
[references/deriving-questions.md](references/deriving-questions.md). The rules for authoritative
sources, concise writing and rewrite order are in
[references/writing-advice.md](references/writing-advice.md).

## Rules that hold in every phase

- Measure page counts using `scripts/doc-metrics.sh`. One page is
  an 80×24 terminal screen.
- Cite `file:line` evidence for every finding and read the cited
  lines before you accept or edit anything.
- Present the derived question set and wait for the user's approval before tracing or changing any file. Fold in the user's edits.
- Use questions to order sections, but never publish the question set as an FAQ.
- Each fact has one authoritative home. Elsewhere, link to it and state the consequence.
- Move sections before polishing prose.
- Verify rewrites with a fresh reader who has no hints and has this skill disabled. Fix or revert failed rewrites. Use a blind check even if you traced the questions yourself, because you already know where the answers are meant to be.
- Auditors and probers are read-only and never spawn their own subagents.

## Scaling

Match the effort to the doc set. For one skill or README, frame, measure and derive in a few
minutes, write 5 to 10 questions, get them approved, trace them yourself, and send one blind prober. For a
repository, write 30 to 50 questions in audience batches of 5 to 8, with one auditor per batch and
one prober per rewritten question or small group. Only the breadth changes between the two.

If the user asks for an audit only, stop after Phase 4. Deliver the report with the ranked
findings and rewrite plan, and leave the Rewrite, Verify and after-numbers sections empty.

Deliver the report in chat, or as a file if the user names one. Keep the question set and
the probe log inside the report, because the next audit reuses them as its regression baseline.
