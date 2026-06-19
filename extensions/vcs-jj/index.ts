/**
 * vcs-jj — contribute the Jujutsu (jj) current change/bookmark to the
 * footer's line 1, overriding the git branch.
 *
 * In a jj repo (even git-colocated — `.jj` *and* `.git` both present) git
 * reports a detached HEAD, so the built-in footer shows `(detached)`. The
 * useful identifier is jj's current change id / bookmark. This extension
 * registers a branch resolver with the shared cpi footer
 * (`extensions/lib/footer.ts`), which owns the footer and renders line 1.
 *
 * vcs-jj does NOT own the footer; it only contributes. The label is
 * resolved via `jj log -r @` (cached, refreshed by the shared footer timer)
 * so it never shells out during render.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCwd } from "../lib/cwd.ts";
import { setBranchResolver, clearBranchResolver } from "../lib/footer.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

const WALK_UP_LIMIT = 40;
const JJ_TIMEOUT_MS = 2000;
// Bookmark(s) at @ if any, else the current change id.
const JJ_TEMPLATE =
  'if(bookmarks.len()>0, bookmarks.map(|b| b.name()).join(" "), change_id.short())';
const JJ_ARGS = ["log", "-r", "@", "-T", JJ_TEMPLATE, "--no-graph", "--ignore-working-copy"];

// ── Module state ────────────────────────────────────────────────────────────

let labelCache: string | null = null;

// ── jj resolution ───────────────────────────────────────────────────────────

/** Walk up from cwd to find the nearest `.jj` (jj repo root). */
function findJjRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < WALK_UP_LIMIT; i++) {
    if (existsSync(join(dir, ".jj"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve the jj label for @, or null if jj is unavailable/not a jj repo. */
function resolveJjLabel(root: string): string | null {
  try {
    const r = spawnSync("jj", JJ_ARGS, {
      cwd: root,
      timeout: JJ_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) return null;
    const s = r.stdout.trim();
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

// ── Contribution ────────────────────────────────────────────────────────────

function install(ctx: ExtensionContext): void {
  const refresh = () => {
    const root = findJjRoot(getCwd());
    labelCache = root ? resolveJjLabel(root) : null;
  };
  refresh(); // prime synchronously so the first render already shows jj
  setBranchResolver(() => labelCache, refresh);
}

export default function vcsJjExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearBranchResolver();
    labelCache = null;
  });
}
