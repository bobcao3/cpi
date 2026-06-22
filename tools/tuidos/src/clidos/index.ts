#!/usr/bin/env bun
import "./color-policy";
import { defineCommand, runMain, type CommandDef } from "citty";
import { projectCommand } from "./commands/project";
import { auditCommand } from "./commands/audit";
import { topicsCommand } from "./commands/topics";
import { countProjects, listProjects } from "../core/db";
import { tuidosDir } from "../core/paths";
import { renderDiscovery, renderUsageShort, renderUsageClean } from "./format";
import { setProjectArg } from "./context";
import { fail } from "./audit-view";

/**
 * Global flags, stripped from argv before `runMain` so they work on every
 * subcommand (citty parses args per-command and would reject an undeclared flag
 * on a leaf). Both are surfaced via channels the core already reads:
 *   --state-dir <path> -> $TUIDOS_STATE_DIR (paths.tuidosDir)
 *   --project/-p <id>   -> context.setProjectArg (requireProject)
 * Declared on the root command's args below purely so `clidos --help` lists
 * them; the values are consumed here, never read from root's parsed args.
 *
 * Only the space forms (`--flag X`, `-p X`) and `--flag=X` are supported — not
 * `-pX`, so a positional value that happens to start with `-p` is never eaten.
 */
function applyGlobalFlags(argv: string[]): string[] {
  const out: string[] = [];
  const take = (next: string | undefined, flag: string): string => {
    if (next == null || next.startsWith("-")) fail(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--state-dir") {
      process.env.TUIDOS_STATE_DIR = take(argv[i + 1], "--state-dir");
      i++;
      continue;
    }
    if (a.startsWith("--state-dir=")) {
      process.env.TUIDOS_STATE_DIR = a.slice("--state-dir=".length);
      continue;
    }
    if (a === "--project") {
      setProjectArg(take(argv[i + 1], "--project"));
      i++;
      continue;
    }
    if (a.startsWith("--project=")) {
      setProjectArg(a.slice("--project=".length));
      continue;
    }
    if (a === "-p") {
      setProjectArg(take(argv[i + 1], "-p"));
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const main = defineCommand({
  meta: { name: "clidos", version: "0.1.0", description: "Local task tracking — non-TTY CLI" },
  args: {
    "state-dir": {
      type: "string",
      description: "Path to the tuidos state dir (default: $TUIDOS_STATE_DIR or XDG state)",
    },
    project: {
      type: "string",
      alias: ["p"],
      description: "Project id or name to scope project commands like `topics`",
    },
  },
  subCommands: { project: projectCommand, audit: auditCommand, topics: topicsCommand },
  // Bare `clidos` discovers itself: its subcommands, the active state, the
  // project count, and a few latest projects — rather than dumping generic help.
  async run({ rawArgs }) {
    // A subcommand was invoked: citty runs ancestor run()s after the leaf, so bail.
    if (rawArgs.length > 0) return;
    console.log(
      renderDiscovery({ statePath: tuidosDir(), count: countProjects(), latest: listProjects(5) }),
    );
  },
});

const argv = applyGlobalFlags(process.argv.slice(2));
runMain(main, {
  rawArgs: argv,
  showUsage: async (cmd: CommandDef<any>, parent?: CommandDef<any>) => {
    const out = argv.includes("-h")
      ? await renderUsageShort(cmd, parent)
      : await renderUsageClean(cmd, parent);
    console.log(`${out}\n`);
  },
});
