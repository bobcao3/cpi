import { toolPackage } from "./tool-package.ts";

export const {
  JsonNode,
  ensureTreeSitterReady,
  highlightCommandSync,
  highlightLangSync,
  initTreeSitterWasm,
  parseCommand,
  parseLangCommand,
} = await toolPackage("@cpi/tree-sitter-wasm");
export type { Highlight, ParseResult } from "@cpi/tree-sitter-wasm";
export type JsonNode = import("@cpi/tree-sitter-wasm").JsonNode;
