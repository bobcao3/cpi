// Resolve and ensure the in-repo Pi fork checkout, cloning it with jj when absent.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(root, ".pi-fork");
const DEFAULT_REMOTE = "https://forge.bc3.moe/bob/pi.git";

export function forkDir() {
  const requested = process.env.CPI_FORK;
  if (!requested) return DEFAULT_DIR;
  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

export function isForkCheckout(dir) {
  return existsSync(join(dir, "packages", "coding-agent", "src"));
}

export function ensureFork() {
  const dir = forkDir();
  if (!isForkCheckout(dir)) {
    if (process.env.CPI_FORK) {
      throw new Error(`CPI_FORK=${dir} is not a Pi fork checkout`);
    }
    const remote = process.env.CPI_FORK_REMOTE ?? DEFAULT_REMOTE;
    const result = spawnSync("jj", ["git", "clone", remote, dir], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`jj git clone ${remote} failed (${result.status})`);
    }
  }
  hydrateFork(dir);
  return dir;
}

function hydrateFork(dir) {
  const dataFile = join(
    dir,
    "packages",
    "ai",
    "src",
    "providers",
    "data",
    "amazon-bedrock.json",
  );
  if (existsSync(dataFile)) return;
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-models.ts", "--strict", "--data-only"],
    {
      cwd: join(dir, "packages", "ai"),
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`generate-models.ts failed (${result.status})`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(`${ensureFork()}\n`);
}
