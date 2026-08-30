# vcs-jj

Show the Jujutsu (`jj`) current change/bookmark as `jj:<bookmark-or-change>` in
pi's custom status row (third footer row), while pi's built-in footer remains
responsible for cwd, git branch, and token/context/model rows.

## Why

pi's built-in footer resolves the branch from `.git` only. A jj repo — even
git-colocated (`.jj` **and** `.git` both present) — reports a detached HEAD to
git, so the footer shows `(detached)` while the identifier you actually care
about is jj's current change id or bookmark. This extension contributes the jj
label to pi's custom status row so the footer reflects jj.

## Behavior

- `.jj` present (pure jj or colocated) → the custom status row shows
  `jj:<bookmark-or-change>`: bookmark(s) at `@` if any, else the current change
  id (e.g. `uvnqxsvxrzlx`).
- No `.jj` → owns nothing; built-in footer (git branch) is untouched.
- `jj` binary missing → degrades to the git branch (proxy falls back).

The label is refreshed every 2s (jj mutations emit no pi event) via
`jj log -r @ --ignore-working-copy`.

## How it stays out of the way

vcs-jj registers a branch resolver with the shared cpi footer bridge
(`extensions/lib/footer.ts`), which is owned by the single cpi extension
(`extensions/core.ts`). Core installs a thin custom footer wrapper that
delegates pi's normal rows to the actual built-in footer Component and appends
the cpi status row. Pi's built-in footer stays in charge of cwd, git branch, and
token/context/model rows, so:

- Built-in thinking, token, context, and model information continues to render
  normally.
- cpi contributors share one muted foreground/background status entry with a
  darker one-cell separator, ordered jj, Fast indicator when active, Codex
  usage, shell/subagent indicators when present, then generated summary last. If
  the combined row exceeds terminal width, the summary moves as a whole to a
  second cpi row.
- Producers contribute via `registerLineSegment` / `setBranchResolver` without
  owning footer rendering.

State is shared across extensions via a `globalThis` slot: pi loads each
extension with jiti `moduleCache: false`, so module-level state is not shared
between importers.

## Stability

Delegating render/invalidate to the captured built-in Component avoids
duplicating pi's footer logic or depending on `FooterComponent`'s private
session shape.
