/**
 * Tree-sitter WASM-based shell AST parsing.
 *
 * Uses our own CI-built tree-sitter-wasm.wasm (WASI module) which bundles
 * tree-sitter + tree-sitter-bash into a single self-contained binary.
 * No npm runtime dependency on web-tree-sitter — eliminates supply chain
 * risk from install scripts.
 *
 * Pure node — no pi/tui imports.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { getWasmPath } from "./tools.ts";

// ── JsonNode: adapter that matches web-tree-sitter's Node API ──

interface RawNode {
  type: string;
  isNamed: boolean;
  fieldName: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  text: string;
  children: RawNode[];
}

export class JsonNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly _isNamed: boolean;
  readonly _fieldName: string | null;
  readonly _children: JsonNode[];
  _parent: JsonNode | null = null;
  _prevNamedSibling: JsonNode | null = null;

  constructor(raw: RawNode, parent: JsonNode | null, prevNamed: JsonNode | null) {
    this.type = raw.type;
    this.text = raw.text;
    this._isNamed = raw.isNamed;
    this._fieldName = raw.fieldName;
    this.startPosition = { row: raw.startRow, column: raw.startCol };
    this.endPosition = { row: raw.endRow, column: raw.endCol };
    this._parent = parent;
    this._prevNamedSibling = prevNamed;

    let lastNamed: JsonNode | null = null;
    this._children = (raw.children ?? []).map((rc) => {
      const child = new JsonNode(rc, this, lastNamed);
      if (child._isNamed) lastNamed = child;
      return child;
    });
  }

  get namedChildren(): JsonNode[] { return this._children.filter((c) => c._isNamed); }
  get children(): JsonNode[] { return this._children; }
  get parent(): JsonNode | null { return this._parent; }
  get previousNamedSibling(): JsonNode | null { return this._prevNamedSibling; }

  childForFieldName(name: string): JsonNode | null {
    return this._children.find((c) => c._fieldName === name) ?? null;
  }

  child(index: number): JsonNode | null {
    return this._children[index] ?? null;
  }

  descendantsOfType(type: string): JsonNode[] {
    const result: JsonNode[] = [];
    const walk = (n: JsonNode): void => {
      if (n.type === type) result.push(n);
      for (const c of n._children) walk(c);
    };
    for (const c of this._children) walk(c);
    return result;
  }

  toString(): string {
    return this._toString(0);
  }
  private _toString(indent: number): string {
    const pad = "  ".repeat(indent);
    const named = this._isNamed ? "" : " (anonymous)";
    const field = this._fieldName ? ` ${this._fieldName}:` : "";
    let s = `${pad}${field}${this.type}${named}`;
    if (this._children.length === 0) s += ` "${this.text}"`;
    else { s += "\n"; for (const c of this._children) s += c._toString(indent + 1); }
    return s;
  }
}

export interface ParseResult { ast: string | null; node: JsonNode | null; available: boolean }

let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function getParser(): Promise<{ alloc: CallableFunction; parse: CallableFunction; resultLen: CallableFunction; memory: WebAssembly.Memory } | null> {
  if (wasmInstance) {
    return {
      alloc: wasmInstance.exports.alloc as CallableFunction,
      parse: wasmInstance.exports.parse as CallableFunction,
      resultLen: wasmInstance.exports.result_len as CallableFunction,
      memory: wasmMemory!,
    };
  }
  try {
    const wasmPath = getWasmPath();
    if (!wasmPath) throw new Error("tree-sitter-wasm.wasm not found in cache");
    const wasmBinary = readFileSync(wasmPath);
    const wasi = new WASI({ version: "preview1", args: ["tree-sitter-wasm"], env: {}, preopens: {} });
    const mod = await WebAssembly.compile(wasmBinary);
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
    wasmInstance = instance;
    wasmMemory = instance.exports.memory as WebAssembly.Memory;
    return {
      alloc: instance.exports.alloc as CallableFunction,
      parse: instance.exports.parse as CallableFunction,
      resultLen: instance.exports.result_len as CallableFunction,
      memory: wasmMemory,
    };
  } catch (err) {
    console.warn("[shell-ext] Failed to initialize tree-sitter-wasm:", err);
    return null;
  }
}

export async function parseCommand(command: string): Promise<ParseResult> {
  const parser = await getParser();
  if (!parser) return { ast: null, node: null, available: false };

  try {
    const encoded = new TextEncoder().encode(command);
    const ptr = parser.alloc(encoded.length) as number;
    if (!ptr) return { ast: null, node: null, available: false };
    const memBuf = new Uint8Array(parser.memory.buffer, ptr, encoded.length);
    memBuf.set(encoded);

    const resultPtr = parser.parse(ptr, encoded.length) as number;
    if (!resultPtr) return { ast: null, node: null, available: false };

    const len = parser.resultLen() as number;
    const resultBytes = new Uint8Array(parser.memory.buffer, resultPtr, len);
    const json = new TextDecoder().decode(resultBytes);
    const raw = JSON.parse(json) as RawNode;

    const node = new JsonNode(raw, null, null);
    return { ast: node.toString(), node, available: true };
  } catch (err) {
    console.warn("[shell-ext] Parse failed:", err);
    return { ast: null, node: null, available: false };
  }
}
