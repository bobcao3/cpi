import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGhostmux } from "@cpi/ghostmux";
import { platforms, platformKey } from "@cpi/ghostmux/source";
import { parseCommand } from "@cpi/tree-sitter-wasm";
import { resolveTreeSitterWasm } from "@cpi/tree-sitter-wasm/resolve";

delete process.env.GHOSTMUX_BIN;
delete process.env.GHOSTMUX_BUILD;
delete process.env.CPI_TS_WASM;
const root = dirname(fileURLToPath(import.meta.url));
const binary = await resolveGhostmux();
assert(!relative(root, binary).startsWith(".."), binary);
const metadata = JSON.parse(
  await readFile(join(dirname(binary), "../native.json"), "utf8"),
);
assert.equal(metadata.cpu_baseline, platforms[platformKey()].baseline);
const capture = spawnSync(binary, ["--history", "--join"], {
  input: "packaged 中文\r\n",
  encoding: "utf8",
  timeout: 10000,
});
assert.ifError(capture.error);
assert.equal(capture.status, 0, capture.stderr);
assert.equal(capture.stdout, "packaged 中文\n");
const wasm = await resolveTreeSitterWasm();
assert(!relative(root, wasm).startsWith(".."), wasm);
const parsed = await parseCommand("printf packaged");
assert.equal(parsed.available, true);
assert.equal(parsed.node.descendantsOfType("command_name")[0].text, "printf");
console.log("Installed cpi uses its signed native package and packaged WASM.");
