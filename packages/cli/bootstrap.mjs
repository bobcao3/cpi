import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

process.env.PI_APPLICATION_MANIFEST = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
process.env.CPI_HOST_SDK_URL = import.meta
  .resolve("@earendil-works/pi-coding-agent");
process.env.CPI_HOST_AI_URL = import.meta
  .resolve("@earendil-works/pi-ai/compat");
process.env.CPI_APP_SDK_URL = import.meta.resolve(
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    .name,
);
process.env.CPI_HOST_CLI = fileURLToPath(
  new URL("./bin/cpi.mjs", import.meta.url),
);
