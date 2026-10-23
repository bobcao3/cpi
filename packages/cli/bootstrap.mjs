import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { configure_storage_environment } from "@cpi/harness/storage-paths";

configure_storage_environment();

process.env.PI_APPLICATION_MANIFEST = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
process.env.CPI_APP_SDK_URL = import.meta.resolve(
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    .name,
);
process.env.CPI_HOST_CLI = fileURLToPath(
  new URL("./bin/cpi.mjs", import.meta.url),
);
export function configureHostRouting(packageDir) {
  const fork = process.env.CPI_FORK && resolve(process.env.CPI_FORK);
  if (
    fork &&
    realpathSync(packageDir) !==
      realpathSync(join(fork, "packages/coding-agent"))
  )
    throw new Error(
      "CPI_FORK does not match the active Pi runtime; load the source SDK through JITI with the fork tsconfig paths",
    );
  process.env.CPI_HOST_ROOT = packageDir;
  process.env.CPI_HOST_SDK_URL = fork
    ? pathToFileURL(join(fork, "packages/coding-agent/src/index.ts")).href
    : import.meta.resolve("@earendil-works/pi-coding-agent");
  process.env.CPI_HOST_AI_URL = fork
    ? pathToFileURL(join(fork, "packages/ai/src/compat.ts")).href
    : import.meta.resolve("@earendil-works/pi-ai/compat");
  process.env.CPI_HOST_TUI_URL = fork
    ? pathToFileURL(join(fork, "packages/tui/src/index.ts")).href
    : import.meta.resolve("@earendil-works/pi-tui");
  if (fork) process.env.CPI_FORK = fork;
}
