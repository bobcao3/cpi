/**
 * Tree-sitter WASM-based shell AST parsing.
 *
 * Loads web-tree-sitter.js + tree-sitter-bash.wasm from the local cache
 * (downloaded from npm registry tarball + GitHub releases respectively).
 * No npm runtime dependency on web-tree-sitter — eliminates supply chain
 * risk from install scripts.
 *
 * Pure node — no pi/tui imports.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getTreeSitterPaths } from "./tools.ts";

// Minimal Node interface — matches the subset of web-tree-sitter's Node
// that rules.ts actually uses. Avoids importing types from the npm package.
export interface TsNode {
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  type: string;
  namedChildren: TsNode[];
  children: TsNode[];
  parent: TsNode | null;
  previousNamedSibling: TsNode | null;
  childForFieldName(name: string): TsNode | null;
  descendantsOfType(type: string): TsNode[];
}

export interface ParseResult { ast: string | null; node: TsNode | null; available: boolean }

let parserInstance: any = null;

export async function parseCommand(command: string): Promise<ParseResult> {
  const { jsPath, wasmDir, grammarPath } = getTreeSitterPaths();
  if (!jsPath || !grammarPath) return { ast: null, node: null, available: false };

  if (!parserInstance) {
    try {
      const mod = await import(pathToFileURL(jsPath).href);
      await mod.Parser.init({ locateFile: (p: string) => join(wasmDir, p) });
      parserInstance = new mod.Parser();
      parserInstance.setLanguage(await mod.Language.load(grammarPath));
    } catch (err) {
      console.warn("[shell-ext] Failed to initialize tree-sitter parser:", err);
      return { ast: null, node: null, available: false };
    }
  }
  try {
    const tree = parserInstance.parse(command);
    return { ast: tree.rootNode.toString(), node: tree.rootNode as TsNode, available: true };
  } catch {
    return { ast: null, node: null, available: false };
  }
}
