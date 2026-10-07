#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import "../source.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const entry = new URL(`../${manifest.exports["./cli"]}`, import.meta.url).href;
if (!entry.endsWith(".ts")) await import(entry);
else {
  const { createJiti } = await import("jiti");
  // CPI_FORK resolves @earendil-works/* from a local fork checkout via its tsconfig paths.
  const fork = process.env.CPI_FORK;
  const tsconfigPaths = fork
    ? join(
        isAbsolute(fork) ? fork : resolve(process.cwd(), fork),
        "tsconfig.json",
      )
    : undefined;
  await createJiti(import.meta.url, {
    tryNative: false,
    ...(tsconfigPaths ? { tsconfigPaths } : {}),
  }).import(entry);
}
