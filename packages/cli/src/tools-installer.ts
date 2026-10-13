import {
  inspectManagedTools,
  installManagedTools,
  loadToolsInstallerText,
  runToolsInstallerTui,
  type InstallProgress,
  type ManagedToolState,
} from "@cpi/harness/tools-installer";

function pad(value: string, width: number): string {
  return value.slice(0, width).padEnd(width);
}

function printTable(tools: ManagedToolState[]): void {
  const text = loadToolsInstallerText();
  process.stdout.write(`${text.cli.columns}\n`);
  for (const tool of tools) {
    process.stdout.write(
      `${pad(tool.status, 13)}${pad(tool.label, 32)}${pad(tool.installed ?? "—", 29)}${tool.desired}\n`,
    );
  }
}

function printJson(tools: ManagedToolState[]): void {
  process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
}

function progressLine(event: InstallProgress): void {
  const text = loadToolsInstallerText();
  const key =
    event.phase === "installing"
      ? "updating"
      : event.phase === "complete"
        ? "updated"
        : "failed";
  const template = text.cli[key];
  process.stderr.write(
    `${template
      .replace("{{tool}}", event.ids.join(", "))
      .replace("{{error}}", event.error ?? "")}\n`,
  );
}

function withoutFlag(args: string[], flag: string): string[] {
  return args.filter((arg) => arg !== flag);
}

export async function runToolsInstallerCommand(
  args: string[],
): Promise<number> {
  const text = loadToolsInstallerText();
  const json = args.includes("--json");
  const positional = withoutFlag(args, "--json");
  const command = positional[0];
  if (!command && process.stdin.isTTY && process.stdout.isTTY) {
    await runToolsInstallerTui();
    return 0;
  }
  if (!command || command === "list" || command === "check") {
    const tools = await inspectManagedTools();
    if (json) printJson(tools);
    else {
      printTable(tools);
      if (command === "check") {
        const count = tools.filter((tool) => tool.status === "update").length;
        process.stdout.write(
          `${count ? text.cli.updates.replace("{{count}}", String(count)) : text.cli.up_to_date}\n`,
        );
      }
    }
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${text.cli.usage}\n`);
    return 0;
  }
  if (command !== "update" && command !== "install") {
    process.stderr.write(`${text.cli.usage}\n`);
    return 2;
  }
  const before = await inspectManagedTools();
  const ids = positional.slice(1);
  const selected = ids.length
    ? ids
    : command === "update"
      ? before.filter((tool) => tool.status === "update").map((tool) => tool.id)
      : [];
  if (!selected.length) {
    if (command === "install") {
      process.stderr.write(`${text.cli.usage}\n`);
      return 2;
    }
    if (json) printJson(before);
    else process.stdout.write(`${text.cli.none_selected}\n`);
    return 0;
  }
  try {
    const tools = await installManagedTools(
      selected,
      process.cwd(),
      json ? undefined : progressLine,
    );
    if (json) printJson(tools);
    else printTable(tools);
    return tools.some(
      (tool) => selected.includes(tool.id) && tool.status !== "current",
    )
      ? 1
      : 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}
