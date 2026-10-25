# Reader-oriented docs audit

Docs fail in three ways. An answer is missing. Unrelated text buries an answer.
Someone copies a fact from its source, and the copy goes stale. This process
finds all three. Derive the reader's questions and measure how much unrelated
text readers skip. Check every fact against its source. Verify each rewrite with
a reader who has no hints.

## Contents

- [Phases](#phases)
- [Rules for every phase](#rules-for-every-phase)
- [Scaling](#scaling)

## Phases

| # | Phase | Output | Exit when |
|---|---|---|---|
| 0 | Frame | readers, jobs, entry points, and scope | every doc in scope has a named reader |
| 1 | Measure | list of files with page counts and heading offsets | you have recorded the baseline numbers |
| 2 | Derive questions | question set, each with a target section | every reader job is covered and the user approves the set |
| 3 | Trace | one evidence row per question, from one auditor per batch or from you | every row has every required field |
| 4 | Consolidate | ranked findings, each with one triage verb | every cited line has been re-read |
| 5 | Rewrite | edited docs | you have applied, declined (with a reason) or deferred every finding |
| 6 | Verify | blind-probe log | every rewritten question passes, or you report it unresolved after two failed fixes |
| 7 | Re-measure and report | before/after table and report | the user has the report |

Follow [references/process.md](references/process.md) for the phases. Build the
question set with
[references/deriving-questions.md](references/deriving-questions.md). Read
[references/writing-advice.md](references/writing-advice.md) for authoritative
sources, concise writing and rewrite order.

## Rules for every phase

- Measure pages with [scripts/doc-metrics.sh](scripts/doc-metrics.sh). One page
  is an 80x24 terminal screen. Measure length with the script, so a number ends
  any dispute about it.
- Cite `file:line` for every finding, and read the cited lines before you accept
  or edit anything. An uncited claim cannot be checked. An auditor who writes
  "the README is vague" gives you nothing to fix.
- Present the question set and wait for approval. Trace and change nothing
  before then. Fold in the user's edits, because the user knows the readers and
  you do not.
- Use questions to order sections. Never publish them as an FAQ, because an FAQ
  orders content by question instead of by the reader's task.
- Give each fact one owner, the file that is authoritative for it. Elsewhere,
  link to the owner and state the consequence, because a copy goes stale and a
  reader who finds it trusts it.
- Move sections before you polish prose. You will delete or relocate some of
  that prose anyway.
- Verify rewrites with a fresh reader who has no hints and cannot load this
  skill. Fix or revert any rewrite that fails. Use a blind check even when you
  traced the questions yourself, because you already know where the answers are
  meant to be.
- Keep auditors and probers read-only, because an auditor that edits changes the
  docs it is measuring. They never spawn subagents.

## Scaling

- **One skill or README.** Frame, measure and derive the questions. Write 5 to
  10 questions and get them approved. Trace them yourself and send one blind
  prober.
- **A repository.** Write 30 to 50 questions in audience batches of 5 to 8. Send
  one auditor per batch, and one prober per rewritten question or small group.

If the user asks for an audit only, stop after Phase 4, because Phases 5 to 7
change the docs and the user did not ask for edits. Deliver the ranked findings
and the rewrite plan. Omit the Verification section and the "pages after" column
of the inventory.

Deliver the report in chat, or as a file if the user names one. Keep the
question set, and the probe log when you ran probes, in the report. The next
audit reuses them as its starting point for comparison.
