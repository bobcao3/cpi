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
const commands = (r: Node): Node[] => r.descendantsOfType("command");
const cmdName = (c: Node): string => resolveEffectiveCommand(c).name;
const cmdArgs = (c: Node): string[] => resolveEffectiveCommand(c).args;

// ── Wrapper resolution (command policy) ──
//
// tree-sitter-bash parses `noglob rm -rf /` as command name `noglob` with `rm`
// as the first argument, so raw name inspection misses the effective command.
// We peel shell precommand/wrapper modifiers to the effective executable before
// the direct-command rules run. This is defense-in-depth command-policy
// extraction on top of Shuck's dialect-specific lint path; the bundled grammar
// is not claimed to be a native zsh/mksh parser.

const MAX_WRAPPER_DEPTH = 4;
const MAX_WRAPPER_ARG_SCAN = 64;
/** Shell precommand/wrapper modifiers recognized by basename (so `/usr/bin/env` peels). */
const WRAPPER_MODIFIERS = new Set(["noglob", "nocorrect", "command", "builtin", "exec", "env"]);

/** Per-wrapper option classification. Each option token is exactly one of:
 * flag (boolean), value (consumes the next arg, or inline `--name=value`), info
 * (non-executing → stop, resolved), or split (split-string → breach). Any token
 * not in these known sets (and not `--`) is unsupported → breach, never guessed. */
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
  flag: new Set(), value: new Set(), info: new Set(), split: new Set(),
  flagLong: new Set(), valueLong: new Set(), infoLong: new Set(), splitLong: new Set(),
};

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  env: {
    flag: setOfChars("i"), value: setOfChars("uC"), info: setOfChars(""), split: setOfChars("S"),
    flagLong: setOfNames("ignore-environment,debug"), valueLong: setOfNames("unset,chdir"),
    infoLong: setOfNames(""), splitLong: setOfNames("split-string"),
  },
  command: {
    flag: setOfChars("p"), value: setOfChars(""), info: setOfChars("vV"), split: setOfChars(""),
    flagLong: setOfNames(""), valueLong: setOfNames(""), infoLong: setOfNames(""), splitLong: setOfNames(""),
  },
  exec: {
    flag: setOfChars("lc"), value: setOfChars("a"), info: setOfChars(""), split: setOfChars(""),
    flagLong: setOfNames(""), valueLong: setOfNames(""), infoLong: setOfNames(""), splitLong: setOfNames(""),
  },
  builtin: NO_OPTS,
  noglob: NO_OPTS,
  nocorrect: NO_OPTS,
};

interface EffectiveCommand {
  name: string;
  args: string[];
  /** "resolved" = name is a real command (or an intentionally non-executing
   * wrapper such as `command -v`); "breach" = a safety limit was hit before the
   * effective command could be resolved, so it is unknown. */
  resolution: "resolved" | "breach";
  /** Present iff resolution === "breach"; empty otherwise. */
  breachReason: string;
}

/** One layer of wrapper peeling. */
type PeelResult =
  | { kind: "word"; name: string; args: string[] }
  | { kind: "info" } // non-executing (e.g. `command -v`): stop, resolved — not a breach
  | { kind: "no-command" } // no plain word and no args remain — benign
  | { kind: "breach"; reason: string }; // split-string, unsupported option, or scan limit

const effectiveCache = new WeakMap<Node, EffectiveCommand>();

function isVarAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Basename of a (possibly path-qualified) command name, preserving no directory. */
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

/** Raw name + args of a command node, excluding leading env assignments from args. */
function rawCommand(cmd: Node): EffectiveCommand {
  return {
    name: cmd.childForFieldName("name")?.text ?? "",
    args: cmd.namedChildren
      .filter((ch) => ch.type !== "command_name" && ch.type !== "variable_assignment")
      .map((ch) => ch.text),
    resolution: "resolved",
    breachReason: "",
  };
}

/**
 * Peel one wrapper modifier layer with explicit, bounded option sets. Only
 * known flag/value/info/split options and `--` are recognized; everything else
 * is an unsupported option → breach. `env -S`/`--split-string` (any form) →
 * breach (split-string executes an encoded command; not parsed). `command -v`/
 * `-V` and other info options → stop, resolved (non-executing). No plain word
 * and no args remain → no-command. Scan limit reached with args remaining →
 * breach.
 */
function peelWrapper(name: string, args: string[]): PeelResult {
  const spec = specFor(name);
  const isEnv = wrapperBasename(name) === "env";
  const limit = Math.min(args.length, MAX_WRAPPER_ARG_SCAN);
  let i = 0;
  while (i < limit) {
    const a = args[i];
    // "--" ends options; the next token is the command (even if option-like).
    if (a === "--") {
      i++;
      return i < args.length ? { kind: "word", name: args[i], args: args.slice(i + 1) } : { kind: "no-command" };
    }
    // Long option: --name or --name=value
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const nm = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const kind = classifyLong(spec, nm);
      if (kind === "split") return { kind: "breach", reason: `split-string option ${a}` };
      if (kind === "info") return { kind: "info" };
      if (kind === "flag" || (kind === "value" && eq >= 0)) { i++; continue; }
      if (kind === "value") { if (i + 1 < limit) { i += 2; continue; } break; }
      return { kind: "breach", reason: `unsupported option ${a}` };
    }
    // Short option(s): only exact single-char `-x` is recognized; attached
    // (`-Sstring`) or combined (`-ix`) forms are ambiguous → breach (split recognized).
    if (a.startsWith("-") && a.length > 1) {
      if (a.length !== 2) {
        if (spec.split.has(a[1])) return { kind: "breach", reason: `split-string option ${a}` };
        return { kind: "breach", reason: `unsupported option ${a}` };
      }
      const kind = classifyShort(spec, a[1]);
      if (kind === "split") return { kind: "breach", reason: `split-string option ${a}` };
      if (kind === "info") return { kind: "info" };
      if (kind === "flag") { i++; continue; }
      if (kind === "value") { if (i + 1 < limit) { i += 2; continue; } break; }
      return { kind: "breach", reason: `unsupported option ${a}` };
    }
    // Not an option (or bare "-"): env skips VAR=value assignments here.
    if (isEnv && isVarAssignment(a)) { i++; continue; }
    return { kind: "word", name: a, args: args.slice(i + 1) };
  }
  if (args.length > MAX_WRAPPER_ARG_SCAN)
    return { kind: "breach", reason: `argument scan exceeded ${MAX_WRAPPER_ARG_SCAN} tokens` };
  return { kind: "no-command" };
}

/** Resolve a command node to its effective executable + args after peeling wrappers. */
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
    if (peeled.kind === "breach") cur = { ...cur, resolution: "breach", breachReason: peeled.reason };
    break;
  }
  // Loop exhausted all MAX_WRAPPER_DEPTH iterations without breaking on a real
  // command and the name is still a wrapper → depth breach.
  if (cur.resolution !== "breach" && depth === MAX_WRAPPER_DEPTH && isWrapperName(cur.name))
    cur = { ...cur, resolution: "breach", breachReason: `wrapper nesting exceeded depth ${MAX_WRAPPER_DEPTH}` };
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
