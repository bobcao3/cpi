/**
 * Detect files WRITTEN TO by a parsed bash command (design §8.2).
 *
 * Pure AST leaf mirroring `shell/cd-targets.ts`: a `detectEdits(root)` returning
 * resolved absolute destinations of editing commands, fed to the post-run LSP
 * check (`shell/lsp-hook.ts`). Conservative — a destination is reported only when
 * it carries a known source extension (so `ls -la` and `> foo` are ignored);
 * targets containing `$` or backticks are skipped (unresolvable without running
 * the shell).
 *
 * Detected patterns:
 *   - `file_redirect` `>`/`>>`/`>|`/`&>`/`&>>` on a content producer
 *     (`echo`/`printf`/`cat`, a heredoc/herestring body, or a pipeline).
 *   - `sed -i` / `sed --in-place`: non-flag file operands.
 *   - `tee` / `tee -a`: non-flag file operands.
 *   - `cp` / `mv`: destination = last non-flag operand.
 *
 * Pure node — no pi/tui imports. Advisory: the shell run already happened.
 */

import type { JsonNode as Node } from "../lib/tree-sitter.ts";
import { resolveCwdPath } from "../lib/cwd.ts";
import { LANGUAGE_EXTENSIONS, LSP_LANGUAGES } from "../lib/lsp/discover.ts";
import { extname, join } from "node:path";
import { homedir } from "node:os";

export interface EditTarget {
  /** Resolved absolute path written to. */
  path: string;
  /** Command name attributed with the write (e.g. "echo", "sed", "cp"). */
  command: string;
  /** 1-based AST row of the destination token. */
  row: number;
  /** 1-based AST column of the destination token. */
  column: number;
}

// ── Explicit limits (design §13 / TigerStyle) ──

/** Cap on detected destinations — bounds output and detects runaway loops. */
const MAX_EDIT_TARGETS = 256;
/** Operators that write to a file (input `<`/`<&` and fd-dup `>&` excluded). */
const WRITE_REDIRECT_OPS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>"]);
/** Commands whose stdout is the body of a `> file` write. */
const PRODUCERS: ReadonlySet<string> = new Set(["echo", "printf", "cat"]);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Union of every language's extensions, for the conservative filter. */
const KNOWN_EXTS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const lang of LSP_LANGUAGES) for (const e of LANGUAGE_EXTENSIONS[lang]) s.add(e);
  assert(s.size > 0, "edit-detect: LANGUAGE_EXTENSIONS is empty");
  return s;
})();

const commandName = (c: Node): string => c.childForFieldName("name")?.text ?? "";
const argNodes = (c: Node): Node[] =>
  c.namedChildren.filter((ch) => ch.type !== "command_name");

function basenameOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

function hasKnownExt(p: string): boolean {
  return KNOWN_EXTS.has(extname(p).toLowerCase());
}

/** Strip one layer of surrounding single/double quotes. */
function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const f = s[0];
  const l = s[s.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'")) return s.slice(1, -1);
  return s;
}

/** Resolve a destination like `cd`-targets: `~`, `~/`, absolute, or relative to cwd. */
function resolveDest(arg: string): string {
  if (arg === "~") return homedir();
  if (arg.startsWith("~/")) return join(homedir(), arg.slice(2));
  return resolveCwdPath(arg);
}

/** The write operator of a `file_redirect`, or null for input/fd-dup redirects. */
function writeOp(r: Node): string | null {
  for (const ch of r.children) {
    if (WRITE_REDIRECT_OPS.has(ch.text)) return ch.text;
  }
  return null;
}

/** Name of the last `command` stage of a `pipeline` (its stdout producer). */
function lastName(pipeline: Node): string {
  const stages = pipeline.namedChildren.filter((c) => c.type === "command");
  const last = stages[stages.length - 1];
  return last ? commandName(last) : "";
}

/**
 * Producer for a `file_redirect` enclosed by a `redirected_statement` (§8.2):
 * its body command (`echo`/`printf`/`cat`), a pipeline body, or any statement
 * carrying a heredoc/herestring input. `{ ok: false }` when the body is not a
 * known content producer (e.g. `ls > f.ts`).
 */
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
  if (heredoc) return { ok: true, name: body?.type === "command" ? commandName(body) : "" };
  return { ok: false, name: "" };
}

/**
 * Error-recovery fallback: when a `file_redirect` has no enclosing
 * `redirected_statement` (tree-sitter wrapped the stray redirect in an `ERROR`
 * node — e.g. an unclosed `cat <<EOF > file`), attribute it to the ERROR's
 * nearest preceding sibling `command` that is a content producer. Returns null
 * when there is no ERROR ancestor or no preceding producer.
 */
function precedingProducerCommand(fr: Node): Node | null {
  let err: Node | null = fr;
  while (err && err.type !== "ERROR") err = err.parent;
  if (!err) return null;
  let prev: Node | null = err.previousNamedSibling;
  while (prev) {
    if (prev.type === "command" && PRODUCERS.has(basenameOf(commandName(prev)))) return prev;
    prev = prev.previousNamedSibling;
  }
  return null;
}

/**
 * The content producer feeding a `file_redirect`, per §8.2. Walks parents to the
 * nearest enclosing `redirected_statement` (the redirect may be nested in a
 * `heredoc_redirect`); on error recovery (no such statement) falls back to the
 * nearest preceding sibling producer command. `{ ok: true, name }` only when the
 * producer is `echo`/`printf`/`cat`, a pipeline, or a heredoc/herestring input.
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
  if (!raw || /[`$]/.test(raw)) return; // variable / substitution — unresolvable
  if (!hasKnownExt(raw)) return; // conservative: known source extension only
  assert(Number.isInteger(dest.startPosition.row), "edit-detect: dest row not an integer");
  out.push({
    path: resolveDest(raw),
    command,
    row: dest.startPosition.row + 1,
    column: dest.startPosition.column + 1,
  });
}

/** Push a command operand as a destination if it is a non-flag known-ext path. */
function pushOperand(out: EditTarget[], arg: Node, command: string): void {
  if (arg.text.startsWith("-")) return;
  pushDest(out, arg, command);
}

/** `sed -i` / `sed --in-place` flags (incl. `-i.bak` and `--in-place=`). */
function sedInPlace(args: Node[]): boolean {
  for (const a of args) {
    const t = a.text;
    if (t === "-i" || t === "--in-place" || /^-i\./.test(t) || /^--in-place(=|$)/.test(t)) {
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
  if (operands.length < 2) return; // need source + destination
  pushOperand(out, operands[operands.length - 1], name);
}

/**
 * Resolved absolute destinations written by editing commands in `root`, or `[]`
 * when `root` is null. Advisory/best-effort: a thrown invariant degrades to the
 * targets gathered so far rather than failing the shell run (mirrors the
 * per-rule `try {} catch {}` in `shell/rules.ts`).
 */
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
  } catch {
    // degrade: return whatever was gathered
  }
  return out;
}
