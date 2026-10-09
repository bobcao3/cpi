import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

process.env.PI_APPLICATION_MANIFEST = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
const fork = process.env.CPI_FORK ?? discoverFork();
if (fork) {
  process.env.CPI_FORK = resolve(fork);
  process.env.CPI_HOST_SDK_URL = pathToFileURL(
    join(process.env.CPI_FORK, "packages/coding-agent/src/index.ts"),
  ).href;
  process.env.CPI_HOST_AI_URL = pathToFileURL(
    join(process.env.CPI_FORK, "packages/ai/src/compat.ts"),
  ).href;
  process.env.CPI_HOST_TUI_URL = pathToFileURL(
    join(process.env.CPI_FORK, "packages/tui/src/index.ts"),
  ).href;
} else {
  process.env.CPI_HOST_SDK_URL = import.meta
    .resolve("@earendil-works/pi-coding-agent");
  process.env.CPI_HOST_AI_URL = import.meta
    .resolve("@earendil-works/pi-ai/compat");
  process.env.CPI_HOST_TUI_URL = import.meta.resolve("@earendil-works/pi-tui");
}
process.env.CPI_APP_SDK_URL = import.meta.resolve(
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    .name,
);
process.env.CPI_HOST_CLI = fileURLToPath(
  new URL("./bin/cpi.mjs", import.meta.url),
);

function discoverFork() {
  const fork = fileURLToPath(new URL("../../.pi-fork", import.meta.url));
  return existsSync(join(fork, "packages/coding-agent/src")) ? fork : undefined;
}
