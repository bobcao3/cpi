#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Comment-probe CLI: extract, strip, or restore a docstring or comment block.
 * Target semantics, guards, and prerequisites live in this skill's SKILL.md.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { agentDir } from "../../../bin/agent-dir.mjs";

const { initTreeSitterWasm, ensureTreeSitterReady, parseLangCommand } = await import("../../../extensions/lib/tree-sitter.ts");

const BAK_SUFFIX = ".probe-bak";

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "typescript", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".jsx": "javascript", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp",
  ".hpp": "cpp", ".hh": "cpp", ".cu": "cuda", ".cuh": "cuda", ".go": "go",
  ".rs": "rust", ".zig": "zig", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml",
  ".sh": "bash", ".bash": "bash",
};

// Decl node types per language, for doc-comment attachment. Absent entries
// fall back to a word match against /function|class|struct|interface|method/.
const DEF_TYPES: Record<string, RegExp[]> = {
  python: [/^(function|class)_definition$/],
  go: [/^(function|method|type)_declaration$/],
  rust: [/^(function|struct|enum|impl|trait|mod|type)_item$|^function_signature_item$/],
  c: [/^function_definition$|^struct_specifier$/],
  cpp: [/^function_definition$|^(struct|class)_specifier$/],
  cuda: [/^function_definition$|^struct_specifier$/],
  bash: [/^function_definition$/],
  javascript: [/function|class|method/, /^(lexical|variable)_declaration$/],
  typescript: [/function|class|method/, /^(lexical|variable)_declaration$/],
};

const PY_DOC_TYPES = [/^(function|class)_definition$/, /^module$/];

function die(msg: string): never {
  console.error(`comment-probe: ${msg}`);
  process.exit(1);
}

function wasmPath(): string {
  if (process.env.CPI_TS_WASM) return process.env.CPI_TS_WASM;
  const candidates = [
    join(agentDir(), "cache/shell-tools/wasm/tree-sitter-wasm.wasm"),
    join(homedir(), "cpi/tree-sitter-wasm/zig-out/bin/tree-sitter-wasm.wasm"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) die("no tree-sitter-wasm found; set CPI_TS_WASM or build cpi/tree-sitter-wasm");
  return found;
}

async function ready(): Promise<void> {
  initTreeSitterWasm(wasmPath);
  if (!(await ensureTreeSitterReady())) die("tree-sitter-wasm failed to initialize");
  const probe = await parseLangCommand("python", "x = 0\n");
  if (!probe.available) die("wasm lacks the parse_lang export; rebuild cpi/tree-sitter-wasm (zig 0.16+)");
}

interface Span {
  start: number; // 1-based inclusive
  end: number;
}

interface Node {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: Node[];
  childForFieldName(name: string): Node | null;
}

function isStandaloneComment(node: Node, lines: string[]): boolean {
  return lines[node.startPosition.row].slice(0, node.startPosition.column).trim() === "";
}

/** Standalone comment nodes, deduped against containing comments (rust nests
 * doc_comment markers inside line_comment spans). */
function commentNodes(root: Node, source: string): Node[] {
  const found: Node[] = [];
  const lines = source.split("\n");
  const walk = (n: Node): void => {
    if (/comment/.test(n.type) && isStandaloneComment(n, lines)) {
      const contained = found.some(
        (f) => f.startPosition.row <= n.startPosition.row && f.endPosition.row >= n.endPosition.row,
      );
      if (!contained) found.push(n);
    }
    for (const child of n.children) walk(child);
  };
  walk(root);
  return found.sort((a, b) => a.startPosition.row - b.startPosition.row);
}

/** Merge comment nodes into maximal runs of consecutive lines. */
function commentRuns(nodes: Node[]): Span[] {
  const runs: Span[] = [];
  for (const n of nodes) {
    const start = n.startPosition.row + 1;
    const textLines = n.text.split("\n");
    let end = n.startPosition.row + textLines.length - (textLines[textLines.length - 1] === "" ? 2 : 1) + 1;
    if (end < start) end = start;
    const last = runs[runs.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else runs.push({ start, end });
  }
  return runs;
}

function docstringSpan(node: Node, lang: string): Span | null {
  const isDef = PY_DOC_TYPES.some((re) => re.test(node.type));
  const body = node.type === "module" || isDef ? node.childForFieldName("body") ?? node : null;
  if (!body) return null;
  const first = body.children.find((c) => !/comment/.test(c.type));
  if (!first) return null;
  if (first.type === "string") {
    return { start: first.startPosition.row + 1, end: first.endPosition.row + 1 };
  }
  if (first.type === "expression_statement") {
    const str = first.children.find((c) => c.type === "string");
    if (!str) return null;
    return { start: str.startPosition.row + 1, end: str.endPosition.row + 1 };
  }
  return null;
}

function matchDef(node: Node, lang: string, name: string): boolean {
  const tests = DEF_TYPES[lang] ?? [/function|class|struct|interface|method/];
  if (!tests.some((re) => re.test(node.type))) return false;
  const named = node.childForFieldName("name");
  const firstLine = node.text.split("\n")[0];
  return named?.text === name || new RegExp(`\\b${name}\\b`).test(firstLine);
}

function findDefs(node: Node, lang: string): Node[] {
  const found: Node[] = [];
  const tests = DEF_TYPES[lang] ?? [/function|class|struct|interface|method/];
  const walk = (n: Node): void => {
    if (tests.some((re) => re.test(n.type))) found.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return found;
}

function resolveDef(root: Node, lang: string, name: string): Node | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return findDefs(root, lang).find((n) => matchDef(n, lang, name)) ?? null;
  const outer = resolveDef(root, lang, name.slice(0, dot));
  if (!outer) return null;
  return findDefs(outer, lang).find((n) => matchDef(n, lang, name.slice(dot + 1))) ?? null;
}

/** Comment run attached to a def: ends at the def or across blank/decorator
 * lines immediately above it. */
function docRunAbove(def: Node, runs: Span[], lines: string[]): Span | null {
  const defRow = def.startPosition.row;
  return runs.find((r) => {
    if (r.end > defRow) return false;
    return lines.slice(r.end, defRow).every((l) => l.trim() === "" || l.trim().startsWith("@"));
  }) ?? null;
}

function resolveSpan(root: Node, source: string, lang: string, target: string): Span {
  if (target.startsWith("comment:")) {
    const anchor = target.slice("comment:".length);
    const nodes = commentNodes(root, source);
    const hit = nodes.find((n) => n.text.includes(anchor));
    if (!hit) die(`no comment line containing ${JSON.stringify(anchor)}`);
    const run = commentRuns(nodes).find((r) => hit.startPosition.row + 1 >= r.start && hit.startPosition.row + 1 <= r.end);
    return run!;
  }
  if (target === "module") {
    if (lang === "python") {
      const span = docstringSpan(root, lang);
      if (!span) die("module has no docstring");
      return span;
    }
    const runs = commentRuns(commentNodes(root, source));
    if (runs.length === 0) die("no leading comment run");
    return runs[0];
  }
  const def = resolveDef(root, lang, target);
  if (!def) die(`target not found: ${target}`);
  if (lang === "python") {
    const span = docstringSpan(def, lang);
    if (!span) die(`no docstring on target: ${target}`);
    return span;
  }
  const run = docRunAbove(def, commentRuns(commentNodes(root, source)), source.split("\n"));
  if (!run) die(`no doc comment directly above: ${target}`);
  return run;
}

interface Block {
  span: Span;
  kind: string;
  target: string | null;
  preview: string;
}

function previewOf(lines: string[], span: Span): string {
  const text = lines[span.start - 1].trim();
  return text.length > 76 ? text.slice(0, 73) + "..." : text;
}

/** Every block a target could address: python docstrings (with dotted def
 * names), non-python doc comments (with def names), and plain comment runs. */
function listBlocks(root: Node, source: string, lang: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  const runs = commentRuns(commentNodes(root, source));
  const used = new Set<number>();
  if (lang === "python") {
    const span = docstringSpan(root, lang);
    if (span) blocks.push({ span, kind: "docstring", target: "module", preview: previewOf(lines, span) });
    const walk = (node: Node, prefix: string): void => {
      for (const child of node.children) {
        if (!PY_DOC_TYPES.some((re) => re.test(child.type)) || child.type === "module") {
          walk(child, prefix);
          continue;
        }
        const name = child.childForFieldName("name")?.text;
        const span = name ? docstringSpan(child, lang) : null;
        if (span) blocks.push({ span, kind: "docstring", target: prefix + name, preview: previewOf(lines, span) });
        walk(child, name ? prefix + name + "." : prefix);
      }
    };
    walk(root, "");
  } else {
    for (const def of findDefs(root, lang)) {
      const run = docRunAbove(def, runs, lines);
      if (!run) continue;
      used.add(run.start);
      const name = def.childForFieldName("name")?.text ?? def.text.split(/[^A-Za-z0-9_]/)[0];
      blocks.push({ span: run, kind: "doc-comment", target: name, preview: previewOf(lines, run) });
    }
  }
  for (const run of runs) {
    if (!used.has(run.start)) blocks.push({ span: run, kind: "comments", target: null, preview: previewOf(lines, run) });
  }
  return blocks.sort((a, b) => a.span.start - b.span.start);
}

function collapseBlank(lines: string[], before: number): void {
  if (0 < before && before < lines.length && !lines[before - 1].trim() && !lines[before].trim()) {
    lines.splice(before - 1, 1);
  }
}

function cmdShow(file: string, lines: string[], span: Span): void {
  for (let n = span.start; n <= span.end; n++) console.log(`${String(n).padStart(5)} ${lines[n - 1]}`);
}

function cmdStrip(file: string, lines: string[], span: Span): string {
  const backup = file + BAK_SUFFIX;
  if (existsSync(backup)) die(`backup already exists, restore first: ${backup}`);
  const kept = [...lines.slice(0, span.start - 1), ...lines.slice(span.end)];
  collapseBlank(kept, span.start - 1);
  writeFileSync(backup, readFileSync(file));
  const fd = `${file}.tmp-${process.pid}`;
  writeFileSync(fd, kept.join("\n") + "\n");
  renameSync(fd, file);
  console.log(`STRIPPED ${file}:${span.start}-${span.end} backup=${backup}`);
  return backup;
}

function cmdRestore(file: string): void {
  const backup = file + BAK_SUFFIX;
  if (!existsSync(backup)) die(`no backup: ${backup}`);
  copyFileSync(backup, file);
  unlinkSync(backup);
  console.log("RESTORED " + file);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const fileArg = args[1];
  const targetIdx = args.indexOf("--target");
  const langIdx = args.indexOf("--lang");
  const target = targetIdx >= 0 ? args[targetIdx + 1] : "module";
  if (!fileArg || (cmd !== "list" && cmd !== "show" && cmd !== "strip" && cmd !== "restore")) {
    die("usage: probe.mts list|show|strip FILE [--target T] [--lang L] | restore FILE");
  }
  if (cmd === "restore") return cmdRestore(fileArg);
  await ready();

  const ext = fileArg.slice(fileArg.lastIndexOf("."));
  const lang = langIdx >= 0 ? args[langIdx + 1] : LANG_BY_EXT[ext];
  if (!lang) die(`unknown extension ${ext}; pass --lang`);
  const source = readFileSync(fileArg, "utf8");
  const parsed = await parseLangCommand(lang, source);
  if (!parsed.available || !parsed.node) die(`parse failed as ${lang}`);
  if (cmd === "list") {
    for (const b of listBlocks(parsed.node, source, lang)) {
      const label = (b.target ?? "").padEnd(24);
      console.log(
        `${String(b.span.start).padStart(5)}-${String(b.span.end).padEnd(5)} ${b.kind.padEnd(11)} ${label} ${b.preview}`,
      );
    }
    return;
  }
  const span = resolveSpan(parsed.node, source, lang, target);
  const lines = source.split("\n");
  if (cmd === "show") return cmdShow(fileArg, lines, span);
  cmdStrip(fileArg, lines, span);
}

await main();
