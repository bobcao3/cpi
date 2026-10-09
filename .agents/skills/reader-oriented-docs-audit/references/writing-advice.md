# Writing and rewrite advice

Targets for any doc touched by an audit: concise, focused on one reader and
one job, answers the questions a reader actually has, and never restates facts
that already live in code, config, text templates, tests, or generated files.

## The one-home rule

Every fact has exactly one authoritative home. A doc states a fact only when
the doc is that home. Everything else is a link plus the consequence.

Drift test: could this line become false while the code, config, or tests stay
correct? If yes, the line duplicates a fact that will drift. Replace it with a
pointer and a contract statement.

| Fact class | Authoritative home | What a doc may say |
|---|---|---|
| Tool descriptions, prompt snippets, guidelines, schema text | `extensions/text/*.toml` | nothing; docs may say which tool owns the behavior |
| CLI flags, defaults, usage | flag definitions and `--help` | one canonical invocation per task; never a flag reference table |
| Config keys, types, defaults | `cpi-config.default.json` and `extensions/lib/config.ts` | where files live, precedence, one annotated minimal example; link for the key list |
| Shell, ghostmux, and protocol limits | `cpi-config.default.json`, `packages/ghostmux/src/wire.zig`, tests | the user-visible consequence; a number users must obey, stated once, in one doc |
| Pi artifact versions and fork revision | `vendor/pi/manifest.json`, `packages/cli/package.json`, `bun.lock` | "pinned; see the manifest" plus the bump procedure |
| Coding rules and source metrics | `AGENTS.md` and `scripts/check.mjs` | never restated in docs or code comments |
| Test, check, and format commands | root `package.json` scripts | one canonical command list in one place; other docs link to it |
| Directory layout | the repository tree | the role of each component in prose; never a file tree |
| Skills and their trigger phrases | `packages/extensions/skills/` | how to write one, not an enumerated catalog |
| Session and cache paths, environment variables | code (`getAgentDir`, `PI_SESSION_DIR`) and fork `docs/environment-variables.md` | the location a reader must use |
| Rendering and presentation contracts | `docs/tool-tree-presentation-design.md` and the renderers | the contract and the user-visible consequence, not the implementation |
| Third-party components and licenses | `NOTICE.md` and package `LICENSE` files | a link |

Two facts are worth restating even though code encodes them: values users must
obey to interoperate (the 30-second `waitfor` cap stated once in its home), and
behavior with a non-obvious consequence (shutdown kills tracked background
shells, or a reload keeps shells while a restart does not). State each once, in
its home, then link.

## Concise and focused

- Purpose in the first three lines: who this doc is for, what it gives them,
  what they need first. A reader must be able to disqualify the doc
  immediately.
- Answer the primary question before the context. Push reference material to
  the end or into a topic doc; never park reference between a quickstart and
  the next task.
- One doc, one audience, one job. Split by task, not by noun.
- Delete sections that restate the title: "Overview", "Introduction",
  "Summary" with no new information.
- One idea per paragraph; active voice naming the actor; imperative for steps.
- Tables for enumerations, bullets for parallel items, prose for reasoning.
- Cut adjectives, hype, and hedges; keep the number or the fact.
- Headings must answer "is this for me?". A runbook heading names the task,
  not the subsystem.
- Avoid "as described above" and "see below"; linked sections are read alone.
- A doc longer than two pages needs a table of contents with working anchors.

## Structure

- Hub and spoke: root README orients and routes; package READMEs cover install,
  consume, and develop; `docs/` topics carry contracts, designs, and reference
  material. Index descriptions must match their targets — a wrong index line
  is a doc bug.
- Ordering inside a doc: what it is, how to start, task walkthroughs,
  reference, internals.
- Every topic doc opens with its contract in a few sentences, then goes deep.
  A reader who stops after the opening should be correct, if incomplete.
- Examples: prefer a maintained, tested example file and link it. When a
  snippet is unavoidable, keep the smallest runnable form and name the
  canonical file. One doc owns each example; others link.
- Config examples: minimal annotated excerpt that teaches the semantics; the
  complete default file lives in the repository, not in prose.

## Rewrite procedure

Triage each audit finding into exactly one verb:

1. **Delete** — redundant with code, text templates, or another doc.
2. **Relocate** — right content, wrong doc or wrong position.
3. **Merge** — the same fact in two places; pick one home.
4. **Rewrite** — right home, unfocused or bloated text.
5. **Link** — the fact has a home; replace the restatement with a pointer.
6. **Add** — a question with no home; answer it in the right doc or declare it
   out of scope explicitly.

Apply moves before edits: relocating a section removes more reader cost than
any sentence-level polish, and editing is easier once text sits in its home.

Then tighten prose, update the index and tables of contents, and fix any index
description the moves invalidated. Verify with blind probes per
`audit-process.md` and re-measure skip costs with `scripts/doc-metrics.mjs`.

Never turn the question list from `references/questions.md` into an FAQ. It is
an instrument: use the answers to decide section order and content, not as a
publishing format.

## Review checklist

- [ ] First screen names audience, purpose, and primary task.
- [ ] Every question the doc targets is answered in the doc or one link away.
- [ ] No restated defaults, flags, keys, versions, directory trees, or
      `extensions/text/*.toml` prompt text; the drift test passes line by line.
- [ ] Index entry and TOC match the doc's actual content.
- [ ] Links resolve and anchors exist; `$CPI_HARNESS_SRC/` and
      `$PI_AGENT_SRC/` prefixes and cross-repo `cpi-fork` links are correct.
- [ ] Reference material sits below task material or in a topic doc.
- [ ] Passages duplicated across docs are merged into one home.
- [ ] A doc longer than two pages has a table of contents.
- [ ] Blind probes passed for the questions the doc claims to answer.
