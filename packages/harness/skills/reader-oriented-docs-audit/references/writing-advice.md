# Writing and rewrite advice

Keep each doc focused on one reader and one task. Answer their questions without
repeating facts that belong in code, config, tests or generated files.

## The one-home rule

Every fact has exactly one authoritative home. A doc states a fact only when
the doc is that home. Other docs link to that home and explain the consequence
for the reader.

Could this line become false while the code, config, or tests stay
correct? If yes, the line duplicates a fact that will drift. Replace it with a
link and an explanation of the consequence.

| Fact class | Authoritative home | What a doc may say |
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
| Design values (colours, spacing, type scale) | the token file or theme source | role names and intent; never hex values or pixel sizes outside the token file |
| Benchmark and tuning values | validation records | semantics and tradeoffs, not chosen numbers |

Two kinds of fact are worth restating even though code encodes them. State values
users must obey to interoperate, since these limits are contracts. Explain behavior
with a non-obvious consequence, such as a mismatch that forces a reload. State each
once, in its home, then link.

## Concise and focused

- State in the first three lines who the doc is for, what it provides, and what
  readers need first. Readers should be able to tell immediately whether the
  doc applies to them.
- Answer the primary question before providing context. Put reference material
  at the end or in a topic doc. Do not put reference material between a
  quickstart and the next task.
- Give each doc one audience and one job. Split docs by task, not by noun.
- Delete sections that restate the title, such as "Overview", "Introduction",
  or "Summary" sections that add no information.
- Put one idea in each paragraph. Use active voice and name the actor; use the
  imperative for steps.
- Use tables for enumerations, bullets for parallel items, and prose for
  reasoning.
- Cut adjectives, hype, and hedges; keep the number or the fact.
- Write headings that answer "is this for me?". A runbook heading names the
  task, not the subsystem.
- Avoid "as described above" and "see below"; linked sections are read alone.

## Structure

- In a multi-component repository, the root README orients readers and routes
  them to component READMEs and topic docs. Component READMEs explain how to
  consume and develop each component. Topic docs in a docs index cover
  contracts, designs, and reference material. Index descriptions must match
  their targets; an incorrect index entry is a doc bug.
- Order a doc by introducing what it is, explaining how to start, walking
  through tasks, and then presenting reference material and internals.
- Open every topic doc with its contract in a few sentences, then explain the
  details. A reader who stops after the opening should be correct, if
  incomplete.
- Prefer a maintained, tested example file and link to it. When a snippet is
  unavoidable, keep it to the smallest runnable form and name the canonical
  file. One doc owns each example; other docs link to it.
- Use a minimal annotated excerpt for config examples to teach the semantics.
  The complete example file lives in the repository, not in prose.

## Rewrite procedure

Triage each audit finding into exactly one action:

1. Delete content that is redundant with code or another doc.
2. Relocate content that is right but in the wrong doc or position.
3. Merge the same fact from two places and choose one home.
4. Rewrite content that is in the right home but unfocused or bloated.
5. Link to the fact's home instead of restating it.
6. Add an answer to a question with no home in the right doc, or explicitly
   declare the question out of scope.

Move sections before editing their prose so you do not polish text that belongs
elsewhere.

Then tighten prose, update the index and tables of contents, and fix any index
description invalidated by the moves. Verify with blind probes per
Phase 6 of `process.md` and re-measure skip costs with `scripts/doc-metrics.sh`.

## Agent skills and design guides

Agents or designers read these guides to take action, often without other
context.

- The front-matter description is the entry point. It must say what the skill
  does and when to load it, using words a user would type.
- Keep the main file short. State the principles and decisions, and provide
  pointers. Put details in reference files that the agent loads only when
  needed.
- Prefer intent and examples to exhaustive rules. Avoid prescribing pixel
  values, per-selector CSS, and long checklists: these details take up context
  and can still miss new cases. Instead, state the principle, show one example,
  and name what to avoid so the guidance generalises better.
- Make sure every rule holds in every variant it claims to cover, such as mode,
  platform, or voice. Otherwise, state plainly where the rule stops.

## Review checklist

- [ ] The first screen names the audience, purpose, and primary task.
- [ ] Every question the doc targets is answered in the doc or one link away.
- [ ] No defaults, flags, keys, versions, directory trees, or test recipes that
      live elsewhere are restated; the drift test passes line by line.
- [ ] The index entry and table of contents match the doc's actual content.
- [ ] Links resolve and anchors exist.
- [ ] Reference material sits below task material or in a topic doc.
- [ ] Passages duplicated across docs are merged into one home.
- [ ] Docs longer than two pages have a table of contents.
- [ ] Blind probes pass for the questions the doc claims to answer.
