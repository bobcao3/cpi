// Resolve and ensure the in-repo Pi fork checkout, cloning it with jj when absent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(root, ".pi-fork");
const DEFAULT_REMOTE = "https://forge.bc3.moe/bob/pi.git";
const CATALOG_BYTES_MAX = 32 * 1024 * 1024;

export function forkDir() {
  const requested = process.env.CPI_FORK;
  if (!requested) return DEFAULT_DIR;
  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

export function isForkCheckout(dir) {
  return existsSync(join(dir, "packages", "coding-agent", "src"));
}

export async function ensureFork() {
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
  await hydrateFork(dir);
  return dir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Provider data is ignored by the fork; hydrate it from the pinned catalog as
// its release artifacts do, again whenever the pin or the data changes.
async function hydrateFork(dir) {
  const { revision } = JSON.parse(
    readFileSync(join(dir, "nix", "model-catalog.json"), "utf8"),
  );
  assert.match(revision, /^sha256-[0-9a-f]{64}$/);
  const cache = join(dir, ".artifacts", "cpi-model-catalog");
  const marker = join(cache, "hydrated.json");
  const manifest = join(dir, "packages/ai/src/providers/data/.manifest.json");
  const hydrated = () => ({
    revision,
    manifest: sha256(readFileSync(manifest)),
  });
  if (existsSync(marker) && existsSync(manifest)) {
    const recorded = JSON.parse(readFileSync(marker, "utf8"));
    if (JSON.stringify(recorded) === JSON.stringify(hydrated())) return;
  }
  const url = `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Pinned model catalog unavailable: ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= CATALOG_BYTES_MAX, "Pinned model catalog exceeds limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  assert.equal(`sha256-${sha256(bytes)}`, revision, "Catalog hash mismatch");
  mkdirSync(cache, { recursive: true });
  const catalog = join(cache, "models.all.json");
  writeFileSync(catalog, bytes);
  const result = spawnSync(
    process.execPath,
    ["packages/ai/scripts/hydrate-model-catalog.ts", catalog],
    { cwd: dir, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`hydrate-model-catalog.ts failed (${result.status})`);
  }
  writeFileSync(marker, `${JSON.stringify(hydrated())}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(`${await ensureFork()}\n`);
}
