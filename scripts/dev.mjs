// Run cpi from this checkout against the in-repo Pi fork checkout (ensuring it exists first).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFork } from "./fork.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fork = ensureFork();
const result = spawnSync(
  process.execPath,
  [join(root, "packages/cli/bin/cpi.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, CPI_FORK: fork } },
);
process.exit(result.status ?? 1);
