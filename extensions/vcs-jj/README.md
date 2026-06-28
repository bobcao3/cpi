# vcs-jj

Show the Jujutsu (`jj`) current change/bookmark in the pi footer instead of the
git branch.

## Why

pi's built-in footer resolves the branch from `.git` only. A jj repo — even
git-colocated (`.jj` **and** `.git` both present) — reports a detached HEAD to
git, so the footer shows `(detached)` while the identifier you actually care
about is jj's current change id or bookmark. This extension contributes the jj
branch to the shared cpi footer so line 1 reflects jj.

## Behavior

- `.jj` present (pure jj or colocated) → footer line 1 shows the jj label:
  bookmark(s) at `@` if any, else the current change id (e.g. `uvnqxsvxrzlx`).
- No `.jj` → owns nothing; built-in footer (git branch) is untouched.
- `jj` binary missing → degrades to the git branch (proxy falls back).

The label is refreshed every 2s (jj mutations emit no pi event) via
`jj log -r @ --ignore-working-copy`.

## How it stays out of the way

vcs-jj does **not** own the footer. It registers a branch resolver with the
shared cpi footer module (`extensions/lib/footer.ts`), which a single cpi
extension (`extensions/core.ts`) owns. The shared footer renders line 1 itself
(composing branch + segments) and splices lines 2/3 from the built-in
`FooterComponent`, so:

- Thinking level, token stats, context %, `(auto)`, extension statuses (`🪨`,
  `bg:N`/`mon:N` from other extensions) all render normally.
- Multiple cpi extensions contribute to line 1 via `registerLineSegment` /
  `setBranchResolver` without any calling `setFooter` themselves.

State is shared across extensions via a `globalThis` slot: pi loads each
extension with jiti `moduleCache: false`, so module-level state is not shared
between importers.

## Permanent fix

An upstream pi `registerVcsProvider` hook + a jj provider in pi core would let
the built-in footer own rendering and remove the need for this override. This
is the cpi-level solution until that lands.
