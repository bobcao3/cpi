import { fileURLToPath } from "node:url";

process.env.PI_APPLICATION_MANIFEST = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
process.env.CPI_HOST_SDK_URL = import.meta
  .resolve("@earendil-works/pi-coding-agent");
process.env.CPI_HOST_AI_URL = import.meta
  .resolve("@earendil-works/pi-ai/compat");
process.env.CPI_APP_SDK_URL = import.meta.resolve("@cpi/cli");
process.env.CPI_HOST_CLI = fileURLToPath(
  new URL("./bin/cpi.mjs", import.meta.url),
);
