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

vcs-jj does **not** replace pi's footer. It registers a branch resolver with the
shared cpi footer bridge (`extensions/lib/footer.ts`), which a single cpi
extension (`extensions/core.ts`) owns, and renders via `ctx.ui.setStatus` into
pi's custom status row. Pi's built-in footer stays in charge of cwd, git branch,
and token/context/model rows, so:

- Thinking level, token stats, context %, `(auto)`, extension statuses (`🪨`,
  `bg:N`/`mon:N` from other extensions), and the built-in rows all render
  normally.
- Multiple cpi extensions contribute to the custom status row via
  `registerLineSegment` / `setBranchResolver` without any replacing pi's footer
  themselves.

State is shared across extensions via a `globalThis` slot: pi loads each
extension with jiti `moduleCache: false`, so module-level state is not shared
between importers.

## Stability

Riding pi's standard footer/status-row plumbing means cpi never depends on pi's
internal `FooterComponent` session shape, so this extension survives pi footer
refactors without touching its internals.
