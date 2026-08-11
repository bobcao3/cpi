import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiInvocation {
  command: string;
  args: string[];
}

function isGenericRuntime(path: string): boolean {
  return /^(node|bun)(\.exe)?$/i.test(basename(path));
}

function installedCli(): string | null {
  try {
    const main = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const cli = join(dirname(main), "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export function resolvePiInvocation(
  args: string[],
  overrideCommand?: string,
): PiInvocation {
  if (overrideCommand) return { command: overrideCommand, args };
  if (!isGenericRuntime(process.execPath))
    return { command: process.execPath, args };
  const current = process.argv[1];
  if (
    current &&
    basename(current).toLowerCase() === "cli.js" &&
    existsSync(current)
  )
    return { command: process.execPath, args: [current, ...args] };
  const cli = installedCli();
  return cli
    ? { command: process.execPath, args: [cli, ...args] }
    : { command: "pi", args };
}
