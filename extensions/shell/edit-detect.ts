/**
 * Detect files WRITTEN TO by a parsed bash command, for the post-run LSP
 * check (shell/lsp-hook.ts). Conservative — known source extensions only; no `$`/backtick targets; advisory, the run already happened.
 */

import type { JsonNode as Node } from "../lib/tree-sitter.ts";
import { resolveCwdPath } from "../lib/cwd.ts";
import { LANGUAGE_EXTENSIONS, LSP_LANGUAGES } from "../lib/lsp/discover.ts";
import { extname, join } from "node:path";
import { homedir } from "node:os";

export interface EditTarget {
  path: string;
  command: string;
  /** 1-based AST row of the destination token. */
  row: number;
  /** 1-based AST column of the destination token. */
  column: number;
}

/** Cap on detected destinations — bounds output and detects runaway loops. */
const MAX_EDIT_TARGETS = 256;
/** Operators that write to a file (input `<`/`<&` and fd-dup `>&` excluded). */
const WRITE_REDIRECT_OPS: ReadonlySet<string> = new Set([
  ">",
  ">>",
  ">|",
  "&>",
  "&>>",
]);
const PRODUCERS: ReadonlySet<string> = new Set(["echo", "printf", "cat"]);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const KNOWN_EXTS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const lang of LSP_LANGUAGES)
    for (const e of LANGUAGE_EXTENSIONS[lang]) s.add(e);
  assert(s.size > 0, "edit-detect: LANGUAGE_EXTENSIONS is empty");
  return s;
})();

const commandName = (c: Node): string =>
  c.childForFieldName("name")?.text ?? "";
const argNodes = (c: Node): Node[] =>
  c.namedChildren.filter((ch) => ch.type !== "command_name");

function basenameOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

function hasKnownExt(p: string): boolean {
  return KNOWN_EXTS.has(extname(p).toLowerCase());
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const f = s[0];
  const l = s[s.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'"))
    return s.slice(1, -1);
  return s;
}

function resolveDest(arg: string): string {
  if (arg === "~") return homedir();
  if (arg.startsWith("~/")) return join(homedir(), arg.slice(2));
  return resolveCwdPath(arg);
}

function writeOp(r: Node): string | null {
  for (const ch of r.children) {
    if (WRITE_REDIRECT_OPS.has(ch.text)) return ch.text;
  }
  return null;
}

function lastName(pipeline: Node): string {
  const stages = pipeline.namedChildren.filter((c) => c.type === "command");
  const last = stages[stages.length - 1];
  return last ? commandName(last) : "";
}

function producerFromBody(stmt: Node): { ok: boolean; name: string } {
  const body = stmt.childForFieldName("body");
  if (body?.type === "pipeline") return { ok: true, name: lastName(body) };
  if (body?.type === "command") {
    const nm = commandName(body);
    if (PRODUCERS.has(basenameOf(nm))) return { ok: true, name: nm };
  }
  const heredoc = stmt.namedChildren.some(
    (r) => r.type === "heredoc_redirect" || r.type === "herestring_redirect",
  );
  if (heredoc)
    return {
      ok: true,
      name: body?.type === "command" ? commandName(body) : "",
    };
  return { ok: false, name: "" };
}

function precedingProducerCommand(fr: Node): Node | null {
  let err: Node | null = fr;
  while (err && err.type !== "ERROR") err = err.parent;
  if (!err) return null;
  let prev: Node | null = err.previousNamedSibling;
  while (prev) {
    if (prev.type === "command" && PRODUCERS.has(basenameOf(commandName(prev))))
      return prev;
    prev = prev.previousNamedSibling;
  }
  return null;
}

/**
 * Content producer feeding a `file_redirect`, falling back to the nearest preceding producer command on tree-sitter ERROR wrap.
 */
function producerOf(fr: Node): { ok: boolean; name: string } {
  let n: Node | null = fr.parent;
  while (n && n.type !== "redirected_statement") n = n.parent;
  if (n) return producerFromBody(n);
  const cmd = precedingProducerCommand(fr);
  return cmd ? { ok: true, name: commandName(cmd) } : { ok: false, name: "" };
}

function pushDest(out: EditTarget[], dest: Node, command: string): void {
  const raw = stripQuotes(dest.text);
  if (!raw || /[`$]/.test(raw)) return;
  if (!hasKnownExt(raw)) return;
  assert(
    Number.isInteger(dest.startPosition.row),
    "edit-detect: dest row not an integer",
  );
  out.push({
    path: resolveDest(raw),
    command,
    row: dest.startPosition.row + 1,
    column: dest.startPosition.column + 1,
  });
}

function pushOperand(out: EditTarget[], arg: Node, command: string): void {
  if (arg.text.startsWith("-")) return;
  pushDest(out, arg, command);
}

/** `sed -i` / `sed --in-place` flags (incl. `-i.bak` and `--in-place=`). */
function sedInPlace(args: Node[]): boolean {
  for (const a of args) {
    const t = a.text;
    if (
      t === "-i" ||
      t === "--in-place" ||
      /^-i\./.test(t) ||
      /^--in-place(=|$)/.test(t)
    ) {
      return true;
    }
  }
  return false;
}

function handleSed(cmd: Node, out: EditTarget[]): void {
  const args = argNodes(cmd);
  if (!sedInPlace(args)) return;
  for (const a of args) pushOperand(out, a, "sed");
}

function handleTee(cmd: Node, out: EditTarget[]): void {
  for (const a of argNodes(cmd)) pushOperand(out, a, "tee");
}

function handleCpMv(cmd: Node, out: EditTarget[], name: string): void {
  const operands = argNodes(cmd).filter((a) => !a.text.startsWith("-"));
  if (operands.length < 2) return;
  pushOperand(out, operands[operands.length - 1], name);
}

/** Written destinations of editing commands in `root`; a thrown invariant degrades to targets gathered so far (advisory). */
export function detectEdits(root: Node | null): EditTarget[] {
  if (!root) return [];
  const out: EditTarget[] = [];
  try {
    for (const fr of root.descendantsOfType("file_redirect")) {
      if (!writeOp(fr)) continue;
      const dest = fr.childForFieldName("destination");
      if (!dest) continue;
      const p = producerOf(fr);
      if (p.ok) pushDest(out, dest, p.name);
      if (out.length >= MAX_EDIT_TARGETS) return out;
    }
    for (const cmd of root.descendantsOfType("command")) {
      const base = basenameOf(commandName(cmd));
      if (base === "sed") handleSed(cmd, out);
      else if (base === "tee") handleTee(cmd, out);
      else if (base === "cp" || base === "mv") handleCpMv(cmd, out, base);
      if (out.length >= MAX_EDIT_TARGETS) return out;
    }
  } catch {}
  return out;
}
