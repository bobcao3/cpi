// Run cpi from this checkout against a local Pi fork checkout (default sibling `cpi-fork`).
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.env.CPI_FORK ?? join(root, "..", "cpi-fork");
const fork = isAbsolute(requested)
  ? requested
  : resolve(process.cwd(), requested);
const result = spawnSync(
  process.execPath,
  [join(root, "packages/cli/bin/cpi.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, CPI_FORK: fork } },
);
process.exit(result.status ?? 1);
