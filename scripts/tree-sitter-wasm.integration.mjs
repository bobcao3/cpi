#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  ensureTreeSitterReady,
  highlightLangSync,
  initTreeSitterWasm,
  parseLangCommand,
} from "../extensions/lib/tree-sitter.ts";

const wasm = resolve(
  process.argv[2] ?? "tree-sitter-wasm/zig-out/bin/tree-sitter-wasm.wasm",
);
initTreeSitterWasm(() => wasm);
assert.equal(await ensureTreeSitterReady(), true);

const source =
  'foreach ($item in Get-ChildItem) { Write-Output "$item"; Start-Sleep -Milliseconds 10 }';
const parsed = await parseLangCommand("powershell", source);
assert.equal(parsed.available, true);
assert.equal(parsed.node?.type, "program");
const names = parsed.node
  ?.descendantsOfType("command_name")
  .map((node) => node.text);
assert.deepEqual(names, ["Get-ChildItem", "Write-Output", "Start-Sleep"]);

const captures = highlightLangSync("powershell", source);
assert(captures && captures.length > 0);
const bytes = new TextEncoder().encode(source);
const decoder = new TextDecoder();
const highlighted = captures.map((capture) => ({
  capture: capture.capture,
  text: decoder.decode(bytes.subarray(capture.start, capture.end)),
}));
assert(
  highlighted.some(
    (entry) => entry.capture === "keyword" && entry.text === "foreach",
  ),
);
assert(
  highlighted.some(
    (entry) => entry.capture === "function" && entry.text === "Write-Output",
  ),
);
assert(
  highlighted.some(
    (entry) => entry.capture === "variable" && entry.text === "$item",
  ),
);
console.log("PowerShell parse and highlight integration passed");
