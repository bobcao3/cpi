/** Shell command rule engine; append an AstRule to defaultRules to add a rule. */

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

const match = (
  n: Node,
  rule: string,
  action: RuleAction,
  msg: string,
): RuleMatch => ({
  rule,
  action,
  message: msg,
  row: n.startPosition.row + 1,
  column: n.startPosition.column + 1,
});
const commands = (r: Node): Node[] => r.descendantsOfType("command");
const cmdName = (c: Node): string => resolveEffectiveCommand(c).name;
const cmdArgs = (c: Node): string[] => resolveEffectiveCommand(c).args;

// tree-sitter-bash parses `noglob rm -rf /` as command name `noglob` with `rm`
// as first arg, so raw name inspection misses the effective executable. Peel
// precommand wrappers to the effective command; unknown options/limits → breach (refuse, never guess).

const MAX_WRAPPER_DEPTH = 4;
const MAX_WRAPPER_ARG_SCAN = 64;
const WRAPPER_MODIFIERS = new Set([
  "noglob",
  "nocorrect",
  "command",
  "builtin",
  "exec",
  "env",
]);

/** Option kinds: flag (bool), value (next arg or --name=value), info (non-executing → resolved), split (split-string → breach); unknown → breach. */
interface WrapperSpec {
  flag: Set<string>;
  value: Set<string>;
  info: Set<string>;
  split: Set<string>;
  flagLong: Set<string>;
  valueLong: Set<string>;
  infoLong: Set<string>;
  splitLong: Set<string>;
}

const setOfChars = (s: string): Set<string> => new Set(s ? s.split("") : []);
const setOfNames = (s: string): Set<string> => new Set(s ? s.split(",") : []);
const NO_OPTS: WrapperSpec = {
  flag: new Set(),
  value: new Set(),
  info: new Set(),
  split: new Set(),
  flagLong: new Set(),
  valueLong: new Set(),
  infoLong: new Set(),
  splitLong: new Set(),
};

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  env: {
    flag: setOfChars("i"),
    value: setOfChars("uC"),
    info: setOfChars(""),
    split: setOfChars("S"),
    flagLong: setOfNames("ignore-environment,debug"),
    valueLong: setOfNames("unset,chdir"),
    infoLong: setOfNames(""),
    splitLong: setOfNames("split-string"),
  },
  command: {
    flag: setOfChars("p"),
    value: setOfChars(""),
    info: setOfChars("vV"),
    split: setOfChars(""),
    flagLong: setOfNames(""),
    valueLong: setOfNames(""),
    infoLong: setOfNames(""),
    splitLong: setOfNames(""),
  },
  exec: {
    flag: setOfChars("lc"),
    value: setOfChars("a"),
    info: setOfChars(""),
    split: setOfChars(""),
    flagLong: setOfNames(""),
    valueLong: setOfNames(""),
    infoLong: setOfNames(""),
    splitLong: setOfNames(""),
  },
  builtin: NO_OPTS,
  noglob: NO_OPTS,
  nocorrect: NO_OPTS,
};

interface EffectiveCommand {
  name: string;
  args: string[];
  resolution: "resolved" | "breach";
  breachReason: string;
}

type PeelResult =
  | { kind: "word"; name: string; args: string[] }
  | { kind: "info" } // non-executing (e.g. `command -v`): stop, resolved — not a breach
  | { kind: "no-command" }
  | { kind: "breach"; reason: string };

const effectiveCache = new WeakMap<Node, EffectiveCommand>();

function isVarAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function wrapperBasename(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash >= 0 ? name.slice(slash + 1) : name;
}
function isWrapperName(name: string): boolean {
  return WRAPPER_MODIFIERS.has(wrapperBasename(name));
}
function specFor(name: string): WrapperSpec {
  return WRAPPER_SPECS[wrapperBasename(name)] ?? NO_OPTS;
}

type OptKind = "flag" | "value" | "info" | "split" | "unknown";
function classifyShort(spec: WrapperSpec, ch: string): OptKind {
  if (spec.split.has(ch)) return "split";
  if (spec.info.has(ch)) return "info";
  if (spec.flag.has(ch)) return "flag";
  if (spec.value.has(ch)) return "value";
  return "unknown";
}
function classifyLong(spec: WrapperSpec, nm: string): OptKind {
  if (spec.splitLong.has(nm)) return "split";
  if (spec.infoLong.has(nm)) return "info";
  if (spec.flagLong.has(nm)) return "flag";
  if (spec.valueLong.has(nm)) return "value";
  return "unknown";
}

function rawCommand(cmd: Node): EffectiveCommand {
  return {
    name: cmd.childForFieldName("name")?.text ?? "",
    args: cmd.namedChildren
      .filter(
        (ch) => ch.type !== "command_name" && ch.type !== "variable_assignment",
      )
      .map((ch) => ch.text),
    resolution: "resolved",
    breachReason: "",
  };
}

function peelWrapper(name: string, args: string[]): PeelResult {
  const spec = specFor(name);
  const isEnv = wrapperBasename(name) === "env";
  const limit = Math.min(args.length, MAX_WRAPPER_ARG_SCAN);
  let i = 0;
  while (i < limit) {
    const a = args[i];
    if (a === "--") {
      i++;
      return i < args.length
        ? { kind: "word", name: args[i], args: args.slice(i + 1) }
        : { kind: "no-command" };
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const nm = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const kind = classifyLong(spec, nm);
      if (kind === "split")
        return { kind: "breach", reason: `split-string option ${a}` };
      if (kind === "info") return { kind: "info" };
      if (kind === "flag" || (kind === "value" && eq >= 0)) {
        i++;
        continue;
      }
      if (kind === "value") {
        if (i + 1 < limit) {
          i += 2;
          continue;
        }
        break;
      }
      return { kind: "breach", reason: `unsupported option ${a}` };
    }
    // Only exact single-char short options are recognized; attached/combined forms are ambiguous → breach.
    if (a.startsWith("-") && a.length > 1) {
      if (a.length !== 2) {
        if (spec.split.has(a[1]))
          return { kind: "breach", reason: `split-string option ${a}` };
        return { kind: "breach", reason: `unsupported option ${a}` };
      }
      const kind = classifyShort(spec, a[1]);
      if (kind === "split")
        return { kind: "breach", reason: `split-string option ${a}` };
      if (kind === "info") return { kind: "info" };
      if (kind === "flag") {
        i++;
        continue;
      }
      if (kind === "value") {
        if (i + 1 < limit) {
          i += 2;
          continue;
        }
        break;
      }
      return { kind: "breach", reason: `unsupported option ${a}` };
    }
    if (isEnv && isVarAssignment(a)) {
      i++;
      continue;
    }
    return { kind: "word", name: a, args: args.slice(i + 1) };
  }
  if (args.length > MAX_WRAPPER_ARG_SCAN)
    return {
      kind: "breach",
      reason: `argument scan exceeded ${MAX_WRAPPER_ARG_SCAN} tokens`,
    };
  return { kind: "no-command" };
}

export function resolveEffectiveCommand(cmd: Node): EffectiveCommand {
  const cached = effectiveCache.get(cmd);
  if (cached) return cached;
  let cur = rawCommand(cmd);
  let depth = 0;
  for (; depth < MAX_WRAPPER_DEPTH; depth++) {
    if (!isWrapperName(cur.name)) break;
    const peeled = peelWrapper(cur.name, cur.args);
    if (peeled.kind === "word") {
      cur = { ...cur, name: peeled.name, args: peeled.args };
      continue;
    }
    if (peeled.kind === "breach")
      cur = { ...cur, resolution: "breach", breachReason: peeled.reason };
    break;
  }
  if (
    cur.resolution !== "breach" &&
    depth === MAX_WRAPPER_DEPTH &&
    isWrapperName(cur.name)
  )
    cur = {
      ...cur,
      resolution: "breach",
      breachReason: `wrapper nesting exceeded depth ${MAX_WRAPPER_DEPTH}`,
    };
  effectiveCache.set(cmd, cur);
  return cur;
}

function hasStdinSource(cmd: Node): boolean {
  if (cmd.children.some((c) => c.type === "herestring_redirect")) return true;
  let n: Node | null = cmd;
  while (n?.parent) {
    const p = n.parent;
    if (p.type === "pipeline" && n.previousNamedSibling) return true;
    if (p.type === "redirected_statement") {
      const r = p.childForFieldName("redirect");
      if (r?.type === "heredoc_redirect" || r?.type === "herestring_redirect")
        return true;
      if (r?.type === "file_redirect" && r.child(0)?.text === "<") return true;
    }
    if (p.type === "program") break;
    n = p;
  }
  return false;
}

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
      args
        .filter((a) => !a.startsWith("-"))
        .some((t) => ["/", "/*", "/.", "/.."].includes(t))
    );
  }),
  cmdRule("no-mkfs", "reject", "filesystem formatting", (cmd) =>
    cmdName(cmd).startsWith("mkfs"),
  ),
  cmdRule(
    "warn-chmod-777",
    "warn",
    "chmod 777 grants world read/write/execute",
    (cmd) =>
      cmdName(cmd) === "chmod" &&
      cmdArgs(cmd).some((a) => a === "777" || a === "a+rwx"),
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
    (cmd) => cmdName(cmd) === "find",
    (ctx) => ctx.fdAvailable,
  ),
  cmdRule(
    "no-grep-use-rg",
    "reject",
    "Use `rg` instead of grep. Use /usr/bin/grep if GNU grep is required",
    (cmd) => {
      const n = cmdName(cmd);
      return (
        ["grep", "egrep", "fgrep"].includes(n) &&
        n !== "/usr/bin/grep" &&
        !hasStdinSource(cmd)
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
          const names = p.namedChildren
            .filter((c) => c.type === "command")
            .map(cmdName);
          return (
            names.some((n) => dl.includes(n)) &&
            names.some((n) => sh.includes(n))
          );
        })
        .map((p) =>
          match(
            p,
            "no-curl-pipe-shell",
            "reject",
            "piping remote content to shell (RCE)",
          ),
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
              ![
                "of=/dev/null",
                "of=/dev/zero",
                "of=/dev/random",
                "of=/dev/urandom",
              ].includes(a),
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
    name: "wrapper-resolution-breach",
    action: "reject",
    check(root) {
      const out: RuleMatch[] = [];
      for (const c of commands(root)) {
        const eff = resolveEffectiveCommand(c);
        if (eff.resolution === "breach")
          out.push(
            match(
              c,
              "wrapper-resolution-breach",
              "reject",
              `shell wrapper modifiers could not be resolved to an effective command within safety limits (${eff.breachReason}); refusing to execute`,
            ),
          );
      }
      return out;
    },
  },
];

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
