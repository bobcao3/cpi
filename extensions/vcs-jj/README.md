# vcs-jj

See [index.ts](index.ts) for the extension.

## Why

pi's built-in footer resolves the branch from `.git` only. A jj repo — even
git-colocated (`.jj` **and** `.git` both present) — reports a detached HEAD to
git, so the footer shows `(detached)` while the identifier you actually care
about is jj's current change id or bookmark. This extension contributes the jj
label to pi's custom status row so the footer reflects jj.

Current jj resolution and lifecycle behavior is authoritative in
[index.ts](index.ts).

## Footer integration

vcs-jj integrates through the shared cpi footer bridge. See
[../lib/footer.ts](../lib/footer.ts) and
[../lib/footer-rows.ts](../lib/footer-rows.ts) for footer integration and layout
behavior.

## Stability

Delegating to pi's built-in footer avoids coupling to its private shape.
