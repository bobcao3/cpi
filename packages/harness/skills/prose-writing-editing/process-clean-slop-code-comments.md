# Comment probe

Keep a comment only if the code cannot say the same thing. To test that, strip
the block, ask a fresh subagent the questions the block answered, and keep the
facts the subagent could not recover. Everything else is noise that will go
stale. A comment that restates `retries = 3` costs the reader a line, and it
will contradict the code after the next edit.

The probe works on Python docstrings and on comment runs in other languages. The
extension table in [probe.mts](scripts/probe.mts) lists them, and cpi's
tree-sitter wasm build parses them.

Start the probe subagent with `--disable-skill prose-writing-editing` and make
its task self-contained in the heredoc, so its context holds nothing but the
task. The backup `FILE.probe-bak` sits next to the stripped file and holds the
removed text, so the prompt in step 4 forbids reading it. cpi sets
`CPI_HARNESS_SRC` to this package's installed root. Use it, and do not assume a
separate `~/cpi` checkout. Every command in the steps uses this launcher:

```sh
probe="$CPI_HARNESS_SRC/skills/prose-writing-editing/scripts/probe"
```

## Contents

- [Steps](#steps)
- [Boundaries](#boundaries)

## Steps

Run the steps in order. Never leave a file stripped, because JJ snapshots the
stripped file automatically and the comment would be gone from the change.

1. **Extract.** List every extractable block. Each line shows the span, the
   kind, the `--target` that addresses the block, and a preview.

   ```sh
   "$probe" list FILE [--lang L]
   "$probe" show FILE [--target T] [--lang L]
   ```

Any target printed by `list` works verbatim in `show`. A comment run prints no
target, so address it with `comment:<text>`. `module` is the default target. It
means the docstring in Python, and the first comment run in other languages.
Other targets are a dotted def path such as `Widget.render` for docstrings, a
def name for doc comments, or `comment:<text>` for a comment run. The text can
be any substring unique to the run. The probe selects the first standalone
comment line containing it and expands to the whole run. Trailing comments never
match. In non-Python languages, a def target takes the comment run above the
declaration, with only blank lines or `@` decorator lines between them. The
language comes from the file extension; `--lang` overrides it.

2. **Question.** Turn every claim in the block into one question. Do not leak
   the answer in the phrasing. Ask "why" for every rationale and design claim,
   because rationale is the part code rarely carries. A block that says "retries
   three times on timeout" yields the question "how many retries happen, and on
   what?". Add one caveats question, "what must a caller know?". Probes return
   extra caveats, so check each one against the block.

3. **Strip.**

   ```sh
   "$probe" strip FILE [--target T] [--lang L]
   ```

The command backs up to `FILE.probe-bak` and refuses to run while a backup
exists. A leftover backup means an earlier run never restored the file. Run step
5, then retry.

4. **Probe.** Launch a fresh subagent with a new session id every run. A resumed
   probe remembers earlier answers, so it is no longer blind. Pass the prompt on
   stdin through a quoted heredoc, never as a positional argument, because the
   shell would expand backticks and variables in the prompt. Do not detach the
   launcher, because you read the verdict next. Set `MODEL` to override the
   default model in the command in this step. Run `subagent --help` for flags,
   and read the `subagents-in-cpi` skill for launcher mechanics.

   ```sh
   subagent -m "${MODEL:-meshy-sglang/zai-org/GLM-5.3-Flash:high}" -s <unique-id> <<'TASK'
   You are probing a source file whose <docstring|comment block> was
   deliberately removed. Answer the questions below PURELY from the remaining
   code, signatures, comments, tests, and callers. Do NOT rely on the removed
   block (it is gone). Cite file:line evidence for every answer. If a question
   cannot be determined from code, say "NOT FINDABLE" and explain what is
   ambiguous.

   File: <absolute path> (repo root: <root>). Also inspect its callers/tests
   under the repo.

   Do not read FILE.probe-bak or any other *.probe-bak file.

   Questions:
   1. ...

   Be terse but precise. End with a one-paragraph verdict: which facts were
   recoverable from code alone and which were only expressible in the removed
   block.
   TASK
   ```

5. **Restore and verify.**

   ```sh
   "$probe" restore FILE
   ```

The command prints `RESTORED` and the file name. Do not continue until you see
it, because a missing line means the file is still stripped.

6. **Prune.** Delete every sentence the probe recovered from code, tests or
   callers with line-cited evidence. Keep a fact when the probe marks it `NOT
   FINDABLE`, or recovers it only from scattered comments in other files or from
   upstream conventions, because a reader of this code would not find it there.
   Then repeat: re-strip, re-probe and re-prune. Stop when a run recovers
   nothing that appears only in the block. If a kept fact guards against a
   silent failure, such as loading an incompatible checkpoint, enforce it with
   an assert, or put a docstring where the code runs. A reader sees those, but
   may never open a distant comment block.

## Boundaries

- Always restore the block, and leave no `.probe-bak` file behind.
- The probe shows which facts the code cannot recover. You write the comment
  text, because the probe finds facts and does not word them.
