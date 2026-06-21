/**
 * Tree-sitter WASM bridge — shared lib module.
 *
 * Loads our CI-built tree-sitter-wasm.wasm (WASI module bundling
 * tree-sitter + tree-sitter-bash + the bash highlight query) and exposes:
 *   - parseCommand(command)        → AST (JsonNode), for semantic rules
 *   - highlightCommandSync(command) → capture byte-ranges, for TUI coloring
 *
 * Pure node (node:fs / node:wasi) — no pi/tui imports. The wasm path is
 * injected by the owner (shell/tools.ts) via initTreeSitterWasm so this module
 * stays a dependency-free leaf.
 *
 * The WebAssembly instance is cached on globalThis: it survives jiti hot-reloads
 * of this file (re-read on every call, never used to skip registration — it is
 * pure data, not a dedup flag).
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";

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
export interface Highlight { start: number; end: number; capture: string }

interface Parser {
  alloc: CallableFunction;
  parse: CallableFunction;
  highlight: CallableFunction;
  highlightLang: CallableFunction;
  langIdByName: CallableFunction;
  langCount: CallableFunction;
  resultLen: CallableFunction;
  memory: WebAssembly.Memory;
}

interface TsState { resolver: () => string | null; instance: WebAssembly.Instance | null; inflight: Promise<Parser | null> | null }

const G = globalThis as unknown as { __cpiTreeSitter?: TsState };

function state(): TsState {
  if (!G.__cpiTreeSitter) G.__cpiTreeSitter = { resolver: () => null, instance: null, inflight: null };
  return G.__cpiTreeSitter;
}

const captureCache = new Map<string, Highlight[]>();
const CAPTURE_CACHE_MAX = 64;

/** Inject the wasm path resolver. Called by the owner (shell/tools.ts) at load. */
export function initTreeSitterWasm(pathResolver: () => string | null): void {
  state().resolver = pathResolver;
}

function wrap(instance: WebAssembly.Instance): Parser {
  const e = instance.exports;
  return {
    alloc: e.alloc as CallableFunction,
    parse: e.parse as CallableFunction,
    highlight: e.highlight as CallableFunction,
    highlightLang: e.highlight_lang as CallableFunction,
    langIdByName: e.lang_id_by_name as CallableFunction,
    langCount: e.lang_count as CallableFunction,
    resultLen: e.result_len as CallableFunction,
    memory: e.memory as WebAssembly.Memory,
  };
}

function parserSync(): Parser | null {
  const st = state();
  return st.instance ? wrap(st.instance) : null;
}

async function instantiate(): Promise<Parser | null> {
  const st = state();
  if (st.instance) return wrap(st.instance);
  if (st.inflight) return st.inflight;
  const p = (async () => {
    const path = st.resolver();
    if (!path) return null;
    try {
      const binary = readFileSync(path);
      const wasi = new WASI({ version: "preview1", args: ["tree-sitter-wasm"], env: {}, preopens: {} });
      const mod = await WebAssembly.compile(binary);
      const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
      st.instance = instance;
      return wrap(instance);
    } catch (err) {
      console.warn("[tree-sitter] Failed to initialize wasm:", err);
      return null;
    }
  })();
  st.inflight = p;
  try {
    return await p;
  } finally {
    st.inflight = null;
  }
}

/** Eagerly instantiate so highlightCommandSync works on first render. Best-effort. */
export async function ensureTreeSitterReady(): Promise<boolean> {
  return (await instantiate()) !== null;
}

export async function parseCommand(command: string): Promise<ParseResult> {
  const parser = await instantiate();
  if (!parser) return { ast: null, node: null, available: false };

  try {
    const encoded = new TextEncoder().encode(command);
    const ptr = parser.alloc(encoded.length) as number;
    if (!ptr) return { ast: null, node: null, available: false };
    new Uint8Array(parser.memory.buffer, ptr, encoded.length).set(encoded);

    const resultPtr = parser.parse(ptr, encoded.length) as number;
    if (!resultPtr) return { ast: null, node: null, available: false };

    const len = parser.resultLen() as number;
    const resultBytes = new Uint8Array(parser.memory.buffer, resultPtr, len);
    const json = new TextDecoder().decode(resultBytes);
    const raw = JSON.parse(json) as RawNode;

    return { ast: new JsonNode(raw, null, null).toString(), node: new JsonNode(raw, null, null), available: true };
  } catch (err) {
    console.warn("[tree-sitter] Parse failed:", err);
    return { ast: null, node: null, available: false };
  }
}

/** Synchronous highlight — returns null if the wasm is not yet instantiated. */
export function highlightCommandSync(command: string): Highlight[] | null {
  const parser = parserSync();
  if (!parser) return null;
  const cached = captureCache.get(command);
  if (cached) return cached;
  try {
    const encoded = new TextEncoder().encode(command);
    const ptr = parser.alloc(encoded.length) as number;
    if (!ptr) return null;
    new Uint8Array(parser.memory.buffer, ptr, encoded.length).set(encoded);

    const resultPtr = parser.highlight(ptr, encoded.length) as number;
    if (!resultPtr) return null;

    const len = parser.resultLen() as number;
    const resultBytes = new Uint8Array(parser.memory.buffer, resultPtr, len);
    const json = new TextDecoder().decode(resultBytes);
    const raw = JSON.parse(json) as { s: number; e: number; c: string }[];
    const result = raw.map((r) => ({ start: r.s, end: r.e, capture: r.c }));
    if (captureCache.size >= CAPTURE_CACHE_MAX) captureCache.delete(captureCache.keys().next().value!);
    captureCache.set(command, result);
    return result;
  } catch (err) {
    console.warn("[tree-sitter] Highlight failed:", err);
    return null;
  }
}

/** Synchronous highlight of `source` as `lang` (e.g. "python"). Returns null
 *  if the wasm is not instantiated or `lang` is unknown. Capture offsets are
 *  UTF-8 byte ranges, same as highlightCommandSync. */
export function highlightLangSync(lang: string, source: string): Highlight[] | null {
  const parser = parserSync();
  if (!parser) return null;
  const cacheKey = lang + "\0" + source;
  const cached = captureCache.get(cacheKey);
  if (cached) return cached;
  try {
    const name = new TextEncoder().encode(lang);
    const namePtr = parser.alloc(name.length) as number;
    if (!namePtr) return null;
    new Uint8Array(parser.memory.buffer, namePtr, name.length).set(name);
    const langId = parser.langIdByName(namePtr, name.length) as number;
    if (langId < 0) return null;

    const encoded = new TextEncoder().encode(source);
    const ptr = parser.alloc(encoded.length) as number;
    if (!ptr) return null;
    new Uint8Array(parser.memory.buffer, ptr, encoded.length).set(encoded);

    const resultPtr = parser.highlightLang(langId, ptr, encoded.length) as number;
    if (!resultPtr) return null;

    const len = parser.resultLen() as number;
    const resultBytes = new Uint8Array(parser.memory.buffer, resultPtr, len);
    const json = new TextDecoder().decode(resultBytes);
    const raw = JSON.parse(json) as { s: number; e: number; c: string }[];
    const result = raw.map((r) => ({ start: r.s, end: r.e, capture: r.c }));
    if (captureCache.size >= CAPTURE_CACHE_MAX) captureCache.delete(captureCache.keys().next().value!);
    captureCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn("[tree-sitter] Highlight failed:", err);
    return null;
  }
}
