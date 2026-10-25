# Writing and rewrite advice

Keep each doc focused on one reader and one task, because a reader with one job
finds a doc with two jobs harder to use. Answer the reader's questions, and
never repeat facts that belong in code, config, tests or generated files.

## Contents

- [The one-owner rule](#the-one-owner-rule)
- [Concise and focused](#concise-and-focused)
- [Structure](#structure)
- [Rewrite procedure](#rewrite-procedure)
- [Agent skills and design guides](#agent-skills-and-design-guides)
- [Review checklist](#review-checklist)

## The one-owner rule

Every fact has exactly one owner, the file that is authoritative for it. A doc
states a fact only when the doc is the owner. Other docs link to the owner and
explain the consequence for the reader. Copies drift, and a reader who finds a
stale copy trusts it.

Ask of every line whether it can become false while the code, config and tests
stay correct. If it can, the line duplicates a fact and will go stale. Replace
it with a link and an explanation of the consequence. A README that lists every
CLI flag is wrong the day someone renames one.

| Fact class | Owner | What a doc may say |
|---|---|---|
| CLI flags, defaults, usage | flag definitions and `--help` | one canonical invocation per task; never a flag reference table |
| Config keys, types, defaults | config parser or schema, example config file | where files live, precedence, one annotated minimal example; link for the key list |
| Constants, limits, magic numbers | source and tests | the user-visible consequence; the number itself only when users must obey it, stated once, in one doc |
| Enumerations of fields, variants or options | the parser, schema or enum and its tests | the contract and the common case; not an exhaustive enumeration copied from a switch statement |
| Compatibility rules | one topic doc plus the source | the rule and what the user observes on mismatch |
| Directory layout | the repository tree | the role of each component in prose; never a file tree |
| API signatures and options | type declarations (`index.d.ts` or equivalent) | one integration example; link for the full API |
| Version pins | build manifests (`package.json`, `go.mod`, `Cargo.toml`, …) | "pinned; see the manifest" plus a bump procedure when non-obvious |
| Test commands, recommended workflows, environment variables | test scripts and CI config | one canonical command list in one place; other docs link to it |
| Third-party components and licenses | the notices file | a link |
| Design values (colors, spacing, type scale) | the token file or theme source | role names and intent; never hex values or pixel sizes outside the token file |
| Benchmark and tuning values | validation records | semantics and tradeoffs, not chosen numbers |

Two kinds of fact belong in the docs even though code encodes them. State values
users must obey to interoperate, because users depend on these limits and a
change breaks them. Explain behavior with a non-obvious consequence, such as a
mismatch that forces a reload. State each once, in the doc that owns it, then
link. When a project forbids restating values in docs, as cpi's AGENTS.md does,
follow that rule and link to the source.

## Concise and focused

- State in the first three lines who the doc is for, what it provides, and what
  readers need first. Readers should know at once whether the doc applies to
  them.
- Answer the primary question before you give context. Put reference material at
  the end or in a topic doc, never between a quickstart and the next task, so
  the reader keeps moving.
- Give each doc one audience and one job, so a reader can decide in seconds
  whether to read it. Give each task its own doc.
- Delete sections that restate the title, such as an "Overview", "Introduction"
  or "Summary" that adds no information.
- Put one idea in each paragraph, so a reader can skim by first sentence. Use
  active voice and name the actor, because the reader must know who acts. Use
  the imperative for steps.
- Use tables for enumerations, bullets for parallel items, and prose for
  reasoning, because each form shows its structure to a skimming reader.
- Cut adjectives and hedges. Keep the number or the fact, because a reader can
  check a number.
- Write headings a reader can match to their own question, such as "is this for
  me?". Name each runbook heading for the task, never the subsystem.
- Never write "as described above" or "see below". Readers arrive by link and
  read one section alone.

## Structure

- In a multi-component repository, the root README orients readers and routes
  them to component READMEs and topic docs. Component READMEs explain how to
  consume and develop each component. Topic docs in a docs index cover
  contracts, designs, and reference material. Index descriptions must match
  their targets; an incorrect index entry is a doc bug.
- Order a doc by introducing what it is, explaining how to start, walking
  through tasks, and then presenting reference material and internals, because a
  reader's need moves from orientation to task to lookup.
- Open every topic doc with its contract in a few sentences, then explain the
  details. When a reader stops after the opening, the reader must have correct,
  if partial, information.
- Prefer a maintained, tested example file and link to it, because tests keep it
  correct. When a snippet is unavoidable, keep it to the smallest runnable form
  and name the canonical file. One doc owns each example; other docs link to it.
- Show config as a minimal annotated excerpt that shows what each setting does.
  Keep the complete example file in the repository, not in prose.

## Rewrite procedure

Triage each audit finding into exactly one action:

1. Delete content that is redundant with code or another doc.
2. Relocate content that is right but in the wrong doc or position.
3. Merge the same fact from two places and choose one owner.
4. Rewrite content that is in the right place but unfocused or bloated.
5. Link to the fact's owner instead of restating it.
6. Add an answer to a question that no doc answers in the right place, or
   declare the question out of scope.

Move sections before you edit their prose. Otherwise you edit text that belongs
elsewhere.

Then tighten prose, update the index and tables of contents, and fix any index
description invalidated by the moves. Verify with blind probes per Phase 6 of
[process.md](process.md) and re-measure skip costs with
[scripts/doc-metrics.sh](../scripts/doc-metrics.sh).

## Agent skills and design guides

Agents or designers read these guides to take action, often without other
context.

- Write the front-matter description first, because it is the entry point. State
  what the skill does and when to load it, in words a user would type.
- Keep the main file short. State the principles and decisions, and point to
  details. Put the details in reference files that the agent loads only when it
  needs them.
- Prefer intent and examples to exhaustive rules. Never prescribe pixel values,
  per-selector CSS or long checklists, because they take up context and still
  miss new cases. State the principle, show one example and name what to avoid,
  so the guidance generalizes.
- Check that every rule holds in every variant it claims to cover, such as dark
  and light mode or each platform. When a rule holds in only some variants,
  state where it stops.

## Review checklist

- [ ] Confirm the first screen names the audience, purpose and primary task.
- [ ] Confirm the doc answers every question it targets, or links to the answer.
- [ ] Confirm the doc restates no default, flag, key, version, directory tree or
      test recipe that lives elsewhere.
- [ ] Confirm every line passes the drift test.
- [ ] Confirm the index entry and table of contents match the doc's content.
- [ ] Confirm links resolve and anchors exist.
- [ ] Confirm reference material sits below task material or in a topic doc.
- [ ] Confirm each passage duplicated across docs has one owner.
- [ ] Confirm every doc longer than two pages has a table of contents, because
      readers skim long docs for their section.
- [ ] Confirm blind probes pass for every question the doc claims to answer.
