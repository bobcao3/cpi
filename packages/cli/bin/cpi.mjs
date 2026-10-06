#!/usr/bin/env node
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const entry = new URL(`../${manifest.exports["./cli"]}`, import.meta.url).href;
if (process.versions.bun || !entry.endsWith(".ts")) await import(entry);
else {
  const { createJiti } = await import("jiti");
  await createJiti(import.meta.url).import(entry);
}
