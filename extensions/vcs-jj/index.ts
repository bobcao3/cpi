import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCwd } from "../lib/cwd.ts";
import { setBranchResolver, clearBranchResolver } from "../lib/footer.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const WALK_UP_LIMIT = 40;
const JJ_TIMEOUT_MS = 2000;
const JJ_TEMPLATE =
  'if(bookmarks.len()>0, bookmarks.map(|b| b.name()).join(" "), change_id.short())';
const JJ_ARGS = [
  "log",
  "-r",
  "@",
  "-T",
  JJ_TEMPLATE,
  "--no-graph",
  "--ignore-working-copy",
];

let labelCache: string | null = null;

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

function install(): void {
  const refresh = () => {
    const root = findJjRoot(getCwd());
    labelCache = root ? resolveJjLabel(root) : null;
  };
  refresh(); // prime synchronously so the first render already shows jj
  setBranchResolver(() => (labelCache ? `jj:${labelCache}` : null), refresh);
}

export default function vcsJjExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, _ctx) => {
    install();
  });

  pi.on("session_tree", async (_event, _ctx) => {
    install();
  });

  pi.on("session_shutdown", async () => {
    clearBranchResolver();
    labelCache = null;
  });
}
