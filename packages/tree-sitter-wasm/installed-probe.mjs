import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ensureTreeSitterReady,
  highlightLangSync,
  parseCommand,
  parseLangCommand,
} from "@cpi/tree-sitter-wasm";
import {
  getTreeSitterWasmPath,
  resolveTreeSitterWasm,
  verifyArtifact,
} from "@cpi/tree-sitter-wasm/resolve";

const path = await resolveTreeSitterWasm();
assert.equal(path, process.argv[2]);
assert.equal(getTreeSitterWasmPath(), path);
assert.equal(await ensureTreeSitterReady(), true);
const bash = await parseCommand("printf '中文'; echo $HOME");
assert.equal(bash.available, true);
assert.deepEqual(
  bash.node.descendantsOfType("command_name").map((node) => node.text),
  ["printf", "echo"],
);
const source = 'foreach ($item in Get-ChildItem) { Write-Output "中文 $item" }';
const parsed = await parseLangCommand("powershell", source);
assert.equal(parsed.node?.type, "program");
assert.deepEqual(
  parsed.node.descendantsOfType("command_name").map((node) => node.text),
  ["Get-ChildItem", "Write-Output"],
);
const captures = highlightLangSync("powershell", source);
const bytes = Buffer.from(source);
assert.ok(
  captures.some(
    ({ start, end, capture }) =>
      capture === "function" &&
      bytes.subarray(start, end).toString() === "Write-Output",
  ),
);
assert.ok(
  captures.some(
    ({ start, end, capture }) =>
      capture === "variable" &&
      bytes.subarray(start, end).toString() === "$item",
  ),
);
assert.equal(
  (await parseLangCommand("not-a-grammar", source)).available,
  false,
);
const wasm = readFileSync(path);
const signature = readFileSync(`${path}.minisig`, "utf8");
verifyArtifact(wasm, signature);
wasm[wasm.length - 1] ^= 1;
assert.throws(
  () => verifyArtifact(wasm, signature),
  /signature verification failed/,
);
console.log(
  "Installed signed WASM parses and highlights Bash and PowerShell without Pi or TypeScript runtime loaders.",
);
