# Deriving the question set

Questions show whether the docs help readers do their jobs. Build a new set for
each doc set from its readers and jobs. Never reuse another project's list
wholesale, because its readers ask different things and the audit would test the
wrong ones. Use a previous list only as a coverage check. The output is a table:

| # | Reader | Question in the reader's words | Entry point | Target section |
|---|---|---|---|---|

## Contents

- [Method](#method)
- [Adjusting for the kind of doc](#adjusting-for-the-kind-of-doc)
- [Pitfalls](#pitfalls)

## Method

1. Start with the readers, their jobs and their entry points from [Phase
   0](process.md#phase-0-frame). A question with no reader cannot show whether
   the docs serve anyone.
2. For each reader, list the questions they ask while doing their tasks. Use the
   reader's vocabulary, not the project's internal names, so the question tests
   whether the reader can find the answer. Cover these stages, because each is a
   point where a reader gets stuck:
   - Orient. Ask what this is, whether it is for the reader, and which part they
     need.
   - Start. Ask for the shortest path to a first success.
   - Do. Ask how to do each common task.
   - Rely. Ask what the product guarantees, and what happens when it fails, is
     upgraded or is misconfigured.
   - Decide. Ask when to choose option A over option B, and what is deliberately
     not supported.
   - Change. Ask where to make a change and how to check it is safe.
   - Recover. Ask what to check first when something is wrong.
3. Mix the kinds of question. Use fact lookups such as "what's the default
   port?", procedures such as "how do I enroll a key?", contracts such as "what
   survives a restart?", judgment calls such as "which mode should this
   dashboard use?" and negative questions such as "what should this never look
   like?". Judgment and negative questions show where docs are vague. Fact
   lookups show where answers are buried.
4. Assign each question a target section, meaning the doc and section a reader
   reaches without skipping unrelated material. When the right place is an
   authority such as code, `--help`, a schema or a token file, the doc points
   there and states the consequence.
5. Overlap questions on purpose, and ask some facts from two readers' angles.
   When questions from different audiences land on the same passage, move it or
   split it, because a passage written for two readers is hard for both to use.
6. Check coverage. Every reader needs at least one question about what the
   product is, whether it is for them and which part they need, and at least one
   about how to do a common task. Use every entry point at least once. Make
   every major section the target section of at least one question, and delete
   any section that answers nothing, because it serves no reader. Include one
   question about a fact that can drift from each authoritative source, because
   drift is where audits find stale copies.
7. Size the set under "Scaling" in
   [reader-oriented-docs-audit.md](../reader-oriented-docs-audit.md), then batch
   it by audience, so each batch shares one path through the docs.

## Adjusting for the kind of doc

- **Repository and library docs.** Prioritize getting started, doing tasks and
  making changes. Check the links from the root README to component and topic
  docs.
- **Agent skills.** Treat the reader as an agent with no context. Ask when the
  skill applies, whether its description triggers it, what to do first, where
  the authoritative values live, and what to do in cases the skill does not
  cover. Check that an agent can act on the skill without reading anything else.
- **Design guides.** Prioritize choosing between options and what to avoid. Ask
  "what's off-brand?" and cover dark and light modes and mobile and desktop. A
  rule that holds in only one mode is a common hidden contradiction.
- **Runbooks.** Prioritize recovery. Name each heading for the symptom or the
  task, never the subsystem, because a reader in trouble searches by symptom. A
  runbook section titled "Storage engine" fails the reader who types "disk
  full".
- **API references.** Prioritize tasks and guarantees. Check that the docs point
  at the type declarations and do not copy them.

## Pitfalls

- Never phrase a question in the docs' own headings. It tests whether a reader
  can match a heading, not whether the docs answer the question.
- Drop questions that only the author would ask, such as internal history or
  implementation trivia. No reader's job depends on them.
