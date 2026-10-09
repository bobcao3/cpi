#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../source.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const entry = new URL(`../${manifest.exports["./cli"]}`, import.meta.url).href;
if (!entry.endsWith(".ts")) await import(entry);
else {
  const { createJiti } = await import("jiti");
  // CPI_FORK resolves @earendil-works/* from a local fork checkout via its tsconfig paths.
  // A source checkout auto-discovers the fork cloned at .pi-fork.
  const requested = process.env.CPI_FORK;
  const fork = requested
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : discoverFork();
  if (fork) process.env.CPI_FORK = fork;
  const tsconfigPaths = fork ? join(fork, "tsconfig.json") : undefined;
  await createJiti(import.meta.url, {
    tryNative: false,
    ...(tsconfigPaths ? { tsconfigPaths } : {}),
  }).import(entry);
}

function discoverFork() {
  const fork = fileURLToPath(new URL("../../../.pi-fork", import.meta.url));
  return existsSync(join(fork, "packages/coding-agent/src")) ? fork : undefined;
}
