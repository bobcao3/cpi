#!/usr/bin/env node
await import(
  new URL("./bin/cpi-prose.mjs", import.meta.resolve("@cpi/prose/package.json"))
);
