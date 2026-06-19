/**
 * AST-based shell command rule engine.
 * "reject" blocks execution; "warn" surfaces to agent only.
 * To add a rule: append an AstRule to `defaultRules`.
 */

import type { JsonNode as Node } from "./parse.ts";

export type RuleAction = "reject" | "warn";
export interface RuleMatch {
  rule: string;
  action: RuleAction;
  message: string;
  row: number;
  column: number;
}
export interface RuleContext {
  fdAvailable: boolean;
  rgAvailable: boolean;
}
export interface AstRule {
  name: string;
  action: RuleAction;
  check: (root: Node) => RuleMatch[];
  condition?: (ctx: RuleContext) => boolean;
}
export interface RuleCheckResult {
  rejections: RuleMatch[];
  warnings: RuleMatch[];
}

// ── Helpers ──

const match = (n: Node, rule: string, action: RuleAction, msg: string): RuleMatch => ({
  rule,
  action,
  message: msg,
  row: n.startPosition.row + 1,
  column: n.startPosition.column + 1,
});
const cmdName = (c: Node): string => c.childForFieldName("name")?.text ?? "";
const cmdArgs = (c: Node): string[] =>
  c.namedChildren.filter((ch) => ch.type !== "command_name").map((ch) => ch.text);
const commands = (r: Node): Node[] => r.descendantsOfType("command");

function hasStdinSource(cmd: Node): boolean {
  if (cmd.children.some((c) => c.type === "herestring_redirect")) return true;
  let n: Node | null = cmd;
  while (n?.parent) {
    const p = n.parent;
    if (p.type === "pipeline" && n.previousNamedSibling) return true;
    if (p.type === "redirected_statement") {
      const r = p.childForFieldName("redirect");
      if (r?.type === "heredoc_redirect" || r?.type === "herestring_redirect") return true;
      if (r?.type === "file_redirect" && r.child(0)?.text === "<") return true;
    }
    if (p.type === "program") break;
    n = p;
  }
  return false;
}

/** Rule that checks each command against a predicate. */
function cmdRule(
  name: string,
  action: RuleAction,
  msg: string,
  pred: (cmd: Node) => boolean,
  condition?: (ctx: RuleContext) => boolean,
): AstRule {
  return {
    name,
    action,
    condition,
    check: (root) =>
      commands(root)
        .filter(pred)
        .map((c) => match(c, name, action, msg)),
  };
}

// ── head/tail pipeline rule helpers ──

/** Commands whose stdout is silent, so a following `cmd | head -N` is still
 *  equivalent to the sh tool's built-in head cap. Conservative on purpose. */
const NO_OUTPUT_BUILTINS = new Set(["cd", "true", "false", ":"]);

/** Flatten a program's top-level statements into left-to-right order,
 *  recursing through list / compound / subshell / redirected_statement bodies
 *  but NOT into pipeline stages (those are not separate output producers). */
function collectStatements(node: Node, out: Node[]): void {
  for (const c of node.namedChildren) {
    switch (c.type) {
      case "list":
      case "compound_statement":
      case "subshell":
        collectStatements(c, out);
        break;
      case "redirected_statement": {
        const body = c.childForFieldName("body");
        if (body) collectStatements(body, out);
        else out.push(c);
        break;
      }
      case "command":
      case "pipeline":
        out.push(c);
        break;
      default:
        break;
    }
  }
}

function basenameOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

function headTailKind(name: string): "head" | "tail" | null {
  const base = basenameOf(name);
  if (base === "head") return "head";
  if (base === "tail") return "tail";
  return null;
}

/** Parse a line-count token. Returns null for `+N` (tail -n +N = from line N,
 *  not a tail cap) and non-positive/non-integer tokens. */
function parseCountToken(token: string): { count: number; raw: string } | null {
  if (token.startsWith("+")) return null;
  if (!/^\d+$/.test(token)) return null;
  const n = Number.parseInt(token, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { count: n, raw: token };
}

/** The line cap a terminal `head`/`tail` stage applies, or null if it does not
 *  cap stdout lines in a way the sh tool's built-in head/tail replicates.
 *
 *  - Explicit count from -N / -n N / -nN / --lines=N → that count.
 *  - Bare `head`/`tail` (no count, no output-changing flag) → POSIX default 10.
 *
 *  Returns null (don't block) for: byte mode (-c/--bytes), verbose header
 *  (-v/--verbose), zero-terminated (-z/--zero-terminated), tail follow
 *  (-f/-F/--follow/--pid/--sleep), `tail -n +N` (from-line), a file operand
 *  (head/tail then reads the file, not the pipe), and malformed `-n`/`--lines`
 *  with no number. */
function lineCap(
  cmd: Node,
  kind: "head" | "tail",
): { count: number; raw: string; explicit: boolean } | null {
  const args = cmdArgs(cmd);
  let expectCount = false;
  let count: { count: number; raw: string } | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (expectCount) {
      expectCount = false;
      if (!count) {
        const c = parseCountToken(a);
        if (c) count = c;
        else return null;
      }
      continue;
    }
    if (!a.startsWith("-") || a === "-") {
      if (a !== "-") return null; // file operand → head/tail reads file, not pipe
      continue;
    }
    if (a.startsWith("--")) {
      if (/^--bytes(=|$)/.test(a)) return null;
      if (a === "--verbose" || a === "--zero-terminated") return null;
      if (kind === "tail" && (a === "--follow" || a.startsWith("--pid") || a.startsWith("--sleep")))
        return null;
      const m = /^--lines=(.+)$/.exec(a);
      if (m) {
        if (!count) {
          const c = parseCountToken(m[1]);
          if (c) count = c;
          else return null;
        }
        continue;
      }
      if (a === "--lines") {
        expectCount = true;
        continue;
      }
      continue; // unknown long flag (e.g. --quiet) → ignore
    }
    const body = a.slice(1);
    for (const ch of body) {
      if (ch === "c" || ch === "v" || ch === "z") return null; // bytes / verbose / zero-terminated
      if (kind === "tail" && (ch === "f" || ch === "F" || ch === "s")) return null; // follow / sleep
    }
    if (body === "n") {
      expectCount = true;
      continue;
    }
    if (!count) {
      const att = /^n(\d+)$/.exec(body);
      if (att) {
        const c = parseCountToken(att[1]);
        if (c) count = c;
        continue;
      }
      const lead = /^(\d+)/.exec(body); // bare -N or -N<flags>
      if (lead) {
        const c = parseCountToken(lead[1]);
        if (c) count = c;
      }
    }
  }
  if (expectCount) return null; // trailing -n/--lines with no number
  if (count) return { count: count.count, raw: count.raw, explicit: true };
  return { count: 10, raw: "10", explicit: false }; // POSIX default 10 lines
}

/** True if the pipeline's stdout is redirected to a file (so head/tail output
 *  does not reach the tool — built-in cap would not replicate it). */
function isStdoutRedirected(pipeline: Node): boolean {
  const rs = pipeline.parent;
  if (!rs || rs.type !== "redirected_statement") return false;
  const red = rs.childForFieldName("redirect");
  if (!red || red.type !== "file_redirect") return false;
  const first = red.child(0);
  let fd: string | null = null;
  let tok: string | null;
  if (first?.type === "file_descriptor") {
    fd = first.text;
    tok = red.child(1)?.text ?? null;
  } else {
    tok = first?.text ?? null;
  }
  if (tok === ">" || tok === ">>" || tok === "&>" || tok === "&>>") {
    return fd === null || fd === "1";
  }
  return false;
}

function isNoOutputCommand(stmt: Node): boolean {
  if (stmt.type !== "command") return false;
  return NO_OUTPUT_BUILTINS.has(basenameOf(cmdName(stmt)));
}

// ── Rules ──

const defaultRules: AstRule[] = [
  cmdRule("no-rm-rf-root", "reject", "rm -rf on root filesystem", (cmd) => {
    const name = cmdName(cmd);
    if (name !== "rm" && !name.endsWith("/rm")) return false;
    const args = cmdArgs(cmd);
    const flags = args
      .filter((a) => a.startsWith("-") && !a.startsWith("--"))
      .map((a) => a.slice(1))
      .join("");
    return (
      (flags.includes("r") || args.includes("--recursive")) &&
      (flags.includes("f") || args.includes("--force")) &&
      args.filter((a) => !a.startsWith("-")).some((t) => ["/", "/*", "/.", "/.."].includes(t))
    );
  }),
  cmdRule("no-mkfs", "reject", "filesystem formatting", (cmd) => cmdName(cmd).startsWith("mkfs")),
  cmdRule(
    "warn-chmod-777",
    "warn",
    "chmod 777 grants world read/write/execute",
    (cmd) => cmdName(cmd) === "chmod" && cmdArgs(cmd).some((a) => a === "777" || a === "a+rwx"),
  ),
  cmdRule(
    "warn-eval",
    "warn",
    "eval is dangerous — consider direct invocation",
    (cmd) => cmdName(cmd) === "eval",
  ),
  cmdRule(
    "no-find-use-fd",
    "reject",
    "Use `fd` instead of find. Use /usr/bin/find if GNU find is required",
    (cmd) => {
      const n = cmdName(cmd);
      return n === "find" && n !== "/usr/bin/find";
    },
    (ctx) => ctx.fdAvailable,
  ),
  cmdRule(
    "no-grep-use-rg",
    "reject",
    "Use `rg` instead of grep. Use /usr/bin/grep if GNU grep is required",
    (cmd) => {
      const n = cmdName(cmd);
      return (
        ["grep", "egrep", "fgrep"].includes(n) && n !== "/usr/bin/grep" && !hasStdinSource(cmd)
      );
    },
    (ctx) => ctx.rgAvailable,
  ),
  {
    name: "no-curl-pipe-shell",
    action: "reject",
    check(root) {
      const dl = ["curl", "wget"],
        sh = ["sh", "bash", "zsh", "dash"];
      return root
        .descendantsOfType("pipeline")
        .filter((p) => {
          const names = p.namedChildren.filter((c) => c.type === "command").map(cmdName);
          return names.some((n) => dl.includes(n)) && names.some((n) => sh.includes(n));
        })
        .map((p) =>
          match(p, "no-curl-pipe-shell", "reject", "piping remote content to shell (RCE)"),
        );
    },
  },
  {
    name: "no-dd-to-device",
    action: "reject",
    check(root) {
      return commands(root)
        .filter((c) => cmdName(c) === "dd")
        .filter((c) =>
          cmdArgs(c).some(
            (a) =>
              a.startsWith("of=/dev/") &&
              !["of=/dev/null", "of=/dev/zero", "of=/dev/random", "of=/dev/urandom"].includes(a),
          ),
        )
        .map((c) =>
          match(
            c,
            "no-dd-to-device",
            "warn",
            `dd writing to device ${
              cmdArgs(c)
                .find((a) => a.startsWith("of=/dev/"))
                ?.slice(3) ?? ""
            }`,
          ),
        );
    },
  },
  {
    // Block pipelines whose terminal stage is `head`/`tail` capping stdout
    // lines: that just caps the tool's own output, which the sh tool's
    // built-in `head`/`tail` args already do. Fires for explicit `-N` and for
    // bare `head`/`tail` (POSIX default 10). Only when the pipeline is the
    // command's terminal output (not redirected to a file, not nested in an
    // outer pipeline, not followed by more output) and any preceding
    // statements are silent (cd/true/false/:). Legit cases are left alone:
    //   `cmd | head | sort`      — head is not the last stage
    //   `cmd | tail -n +5`       — from-line-N, not a tail cap
    //   `cmd | tail -f`          — follow, no cap
    //   `cmd | head -5 > f`      — output goes to a file
    //   `cmd | head -5 file`     — head reads the file, not the pipe
    //   `cmd | head -v`          — verbose header changes output
    //   `echo x; cmd | head -5`  — preceding statement emits stdout
    name: "no-pipe-head-tail",
    action: "warn",
    check(root) {
      const stmts: Node[] = [];
      collectStatements(root, stmts);
      if (stmts.length === 0) return [];
      const terminal = stmts[stmts.length - 1];
      if (terminal.type !== "pipeline") return [];
      if (isStdoutRedirected(terminal)) return [];
      const stages = terminal.namedChildren.filter((c) => c.type === "command");
      const last = stages[stages.length - 1];
      if (!last) return [];
      const kind = headTailKind(cmdName(last));
      if (!kind) return [];
      const cap = lineCap(last, kind);
      if (!cap) return [];
      for (let i = 0; i < stmts.length - 1; i++) {
        if (!isNoOutputCommand(stmts[i])) return [];
      }
      const capDesc = cap.explicit
        ? `${cap.count} line(s)`
        : `${cap.count} line(s) (shell default; no -N given)`;
      return [
        match(
          last,
          "no-pipe-head-tail",
          "warn",
          `Please use the sh tool's built-in argument: \`${kind} = ${cap.count}\`, instead of piping to ${kind}. This way lines that are truncated will be preserved and can be recovered from logs.`,
        ),
      ];
    },
  },
];

// ── Engine ──

export function checkRules(
  root: Node,
  ctx: RuleContext = { fdAvailable: false, rgAvailable: false },
): RuleCheckResult {
  const all: RuleMatch[] = [];
  for (const rule of defaultRules) {
    if (rule.condition && !rule.condition(ctx)) continue;
    try {
      all.push(...rule.check(root));
    } catch {}
  }
  return {
    rejections: all.filter((m) => m.action === "reject"),
    warnings: all.filter((m) => m.action === "warn"),
  };
}

export function formatRuleMatches(matches: RuleMatch[]): string {
  return matches
    .map((m) => `  L${m.row}:${m.column} ${m.action}[${m.rule}] ${m.message}`)
    .join("\n");
}
