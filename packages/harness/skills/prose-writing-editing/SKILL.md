---
name: prose-writing-editing
description:
  Write clear, readable, understandable prose, while abstaining from AI tells.
  Invoke always when writing docs, or asked to edit / improve / prune code
  comments. Avoid AI patterns and jargon. Invoke when trying to communicate to
  the user clearly
---

When writing any prose, including code comments, documentation, docstring, error
messages, or any human facing text.

To understand what AI tells are and how to spot & avoid them, read ./unslop.md

When writing or editing code comments, consider following both approaches:

- Reader QA oriented auditing, and to check against verbosity or duplication,
  read ./reader-oriented-docs-audit.md
- Invoke `cpi-prose` tooling, to compare the writing style and cadence against a
  known good reference. Unless already specified by the user, please confirm the
  choice of reference corpus.
- When matching existing writing style, not only match the tone, the sentence
  length, readability metrics, it is also very important to match the
  distribution. Human writing has emphasis and varied cadence.

When writing documentation, you should also follow these processes:

- Reader QA to make sure the documentation conveys what is necessary, don't
  include useless information, and make sure the information is truthful. Read
  ./reader-oriented-docs-audit.md
- Use the same `cpi-prose` tooling to compare the writing style against a known
  good reference document.
