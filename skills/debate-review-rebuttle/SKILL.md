---
name: debate-review-rebuttle
description:
  Use when the user wants code or docs reviewed through an adversarial
  multi-agent debate — reviewer subagents raise findings, a defender rebuts, and
  an adjudicator rules — producing verified, actionable findings instead of
  unfiltered review noise.
---

# Debate Review Rebuttle

Adversarial review loop: **review → rebut → adjudicate**, repeated in rounds.
Every finding must survive a defense and an evidence-checked adjudication before
it reaches the user. Orchestrator coordinates; subagents argue.

## Setup: ask the user first

Before proposing configuration or launching anything, run `pi --list-models`.
Then propose and confirm this setup:

- Every proposed value must be concrete: name an available `provider/model`
  identifier from the command output and an explicit effort level; never use
  vague wording such as "a strong reasoning model", "whatever is best", or
  placeholders like `provider/model:max`. Propose explicit reviewer counts and
  round counts too. Keep the scope (specific files/dirs) and rules (specific
  rule documents) explicit.

| Input                        | Default                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Scope (files/dirs to review) | none — must ask                                                                 |
| Rules to review against      | repo style guides (CLAUDE.md/AGENTS.md) + relevant local skills                 |
| Subagent model               | select and propose one exact model from `pi --list-models` output at max effort |
| Reviewers per file (max 2)   | 2                                                                               |
| Rounds                       | 3 (user-overridable)                                                            |

Concurrency scales ACROSS files, not within one file — never more than 2
reviewers on the same file. When many files are in scope, fan out by file/module
(multiple files' phases in parallel) rather than adding reviewers.

Rules may be stated broadly ("coding style", "correctness"). It is the
orchestrator's job to **pinpoint the exact rule documents**: local skills, repo
CLAUDE.md/AGENTS.md files, and upstream docs/sites. Cite the exact file or URL
in every subagent prompt so findings are verifiable, not taste.

## Process

Depth-first per file batch: a file goes through all rounds before the next batch
starts. Do not breadth-first the whole scope per round.

### Phase 0 — Trial

1. Pick a few representative files (2-3) from the scope.
2. Run one full round (below) on them.
3. Report calibrated results to the user; confirm scope/rules before the full
   run.

### Each round (per file)

1. **Review** — launch up to 2 reviewer subagents per file (one broad-sweep, one
   ruling-attacker in rounds 2+), parallelizing across files when scope allows.
   Each reviewing the file against the pinned rules. Each returns
   line-referenced findings. Deduplicate/merge their findings into one list.
2. **Rebut** — launch one defender subagent with the merged findings. It reads
   the file itself and defends, concedes, or reframes each finding.
3. **Adjudicate** — launch one adjudicator subagent given both sides. It must
   **independently verify every line number and quoted code against the actual
   file** (both sides hallucinate), then rule per finding: accepted change /
   dismissed / reframed, with concrete fix instructions.
4. **Next round** — feed the adjudicated accepted+reframed findings into the
   next round's reviewer prompt as "previously disputed — attack or confirm", so
   later rounds deepen instead of repeating.

### Subagent prompt essentials

- Always include: absolute file paths, exact rule documents, role, and "do not
  edit files — review only" (except an optional final fixer round).
- Reviewer: terse, line-referenced findings with suggested fixes.
- Defender: "a weak defense is worse than a concession."
- Adjudicator: "distrust both sides; verify against the code."
- For single ad-hoc launches, use the `subagent` helper directly per the
  subagents-in-pi skill. For fan-out phases (review/rebut/adjudicate), use
  `run_phase.py` (below). Background and collect via completion notifications.
  Never poll.

### Orchestration template

This skill ships `run_phase.py`, a phase runner: give it a JSON manifest of
`{id, prompt}` entries and it fans subagents out with bounded concurrency,
saving each final answer to `results/<id>.md`. It is idempotent on re-run —
completed ids are skipped.

Per file, the orchestrator:

1. Copies `run_phase.py` into a per-run workspace outside the audited repo:
   `~/.debate-review/<project-slug>/<file-or-scope-slug>/`. Never create the
   workspace inside the repo under review — manifests, reports, and rulings must
   stay out of the target's version control. Subagent prompts must then
   reference absolute paths for both the review targets and the ledger files.
2. Adjusts the `PROVIDER` / `MODEL` / `EFFORT` / `MAX_WORKERS` constants at the
   top of the copied script per the user's setup answers.
3. Generates one manifest per phase: `round-N-review`, `round-N-rebut`,
   `round-N-adjudicate`. Manifests support a shared `"template"` with
   `{{PLACEHOLDERS}}` plus per-entry `"vars"`. Write ONE role template per phase
   — with the pinned rule documents, target file, role instructions, and output
   format baked in — and vary only the focus or finding list per entry. Prefer
   this over inlining a dozen near-identical prompts. Literal `"prompt"` keys
   still work for one-off entries like the defender and adjudicator.
4. Launches it backgrounded via the sh tool:
   `python3 run_phase.py manifest.json results/`, then collects on the
   completion notification. Backgrounding is sh-tracked only: never use
   `sh_detach`, `setsid`, `nohup`, or `disown`; the phase remains bounded by
   root pi's lifetime.

Progress is tracked by the workspace itself — the manifests and results dirs are
the ledger. List them to see each phase's status; no separate state file.

### Output

Per round: a scorecard (finding → verified facts → verdict → concrete change).
Final: an ordered list of accepted changes only, each with verified line
references. Note transcription slips subagents made (misquoted code) separately
from substance.

## Boundaries

- This skill is review/adjudication only. Applying accepted changes is a
  separate step — confirm with the user before editing.
- Not for debugging a known failure (use systematic-debugging) or designing new
  architecture (use QRSPI).
- If all findings in a round are dismissed, stop early — more rounds won't help.
