import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stage_wasm } from "./package-api.mjs";

const [input, output] = process.argv.slice(2);
assert(
  input && output && process.argv.length === 4,
  "Usage: package.mjs SIGNED_WASM NEW_DESTINATION",
);
const destination = resolve(output);
await assert.rejects(lstat(destination), { code: "ENOENT" });
await mkdir(destination, { recursive: true });
await stage_wasm(join(destination, "package"), resolve(input));
const packed = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
  {
    cwd: join(destination, "package"),
    encoding: "utf8",
    timeout: 120000,
    shell: process.platform === "win32",
  },
);
assert.ifError(packed.error);
assert.equal(packed.status, 0, packed.stderr);
console.log(packed.stdout);
