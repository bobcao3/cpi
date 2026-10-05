import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["index.ts", "resolve.ts"],
  outdir: ".",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  chunkNames: "runtime",
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
});
