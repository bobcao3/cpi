# Deriving the question set

Questions show whether the docs help readers do their jobs. Build a new set for each doc set
from its readers and jobs, and never reuse another project's list wholesale. A previous list
is useful only as a coverage check. The output is a table:

| # | Reader | Question in the reader's words | Entry point | Intended home |
|---|---|---|---|---|

## Method

1. Start with the readers, their jobs and their entry points from Phase 0.
2. For each reader, list the questions they would actually ask while doing their tasks. Use
   the reader's own vocabulary rather than the project's internal names. Include these stages:
   - Orient. What is this, is it for me, and which part do I need?
   - Start. What is the shortest path to a first success?
   - Do. How do I do each common task?
   - Rely. What is guaranteed? What happens when something fails, is upgraded or is misconfigured?
   - Decide. When should I choose option A over option B? What is deliberately not supported?
   - Change. Where do I make a change, and how do I check it is safe?
   - Recover. Something is wrong. What do I check first?
3. Include different kinds of question. Include fact lookups ("what's the default port?"),
   procedures ("how do I enrol a key?"), contracts ("what survives a restart?"), judgement
   calls ("which mode should this dashboard use?") and negative questions ("what should this
   never look like?"). Judgement and negative questions expose vague docs. Fact lookups expose
   buried ones.
4. Assign an intended home to each question: the doc and section a reader should reach without
   skipping unrelated material. When the right home is an authority such as code, `--help`,
   a schema or a token file, the doc's job is to point there and state the consequence.
5. Include deliberate overlap. Ask some facts from two readers' angles. If two questions from
   different audiences land on the same passage, that passage is probably in the wrong place,
   or needs to be split.
6. Check coverage. Every reader has at least one question about what the product is, whether
   it is for them and which part they need, and at least one question about how to do a common
   task. Use every entry point at least once. Make every major section of the docs the intended
   home of at least one question; a section that answers nothing is a deletion candidate.
   Include at least one question about a fact that could drift from each authoritative source.
7. Size the set using SKILL.md's "Scaling" section, then batch it by audience.

## Adjusting for the kind of doc

- For repository docs, prioritize questions about getting started, doing tasks and making
  changes. Check the links from the root README to component and topic docs.
- For agent skills, the reader is an agent with no context. Ask when the skill applies and
  whether its description will trigger it, what to do first, where the authoritative values
  are, and how to handle cases the skill doesn't cover. Also ask whether the skill tells agents
  how to act without unnecessary details or context.
- For design guides, prioritize questions about choosing between options and what to avoid.
  Ask "what's off-brand?" and cover modes such as dark and light, mobile and desktop. A rule that
  holds in only one mode is a common hidden contradiction.
- For runbooks, prioritize questions about recovery. A heading should name the symptom or task, not the
  subsystem.
- For API references, prioritize questions about doing tasks and relying on guarantees. Check that the docs point at the type declarations
  instead of copying them.

## Pitfalls

- Questions phrased in the docs' own headings test whether a reader can match a heading, not
  whether the docs answer the question. Use the reader's words instead.
- Questions that only the author would ask, such as internal history or implementation
  trivia, don't belong in the set.
