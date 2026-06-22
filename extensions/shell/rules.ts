/**
 * AST-based shell command rule engine.
 * "reject" blocks execution; "warn" surfaces to agent only.
 * To add a rule: append an AstRule to `defaultRules`.
 */

import type { JsonNode as Node } from "../lib/tree-sitter.ts";

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
