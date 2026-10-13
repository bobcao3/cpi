import "../bootstrap.mjs";
import { main, setupCli } from "./index.ts";

setupCli();
process.env.AI_AGENT = "cpi";
const args = process.argv.slice(2);
if (args[0] === "tools-installer") {
  const { runToolsInstallerCommand } = await import("./tools-installer.ts");
  process.exitCode = await runToolsInstallerCommand(args.slice(1));
} else await main(args);
