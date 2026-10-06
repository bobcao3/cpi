import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requested = process.argv[2] ?? "all";
assert(["all", "ghostmux", "tree-sitter-wasm"].includes(requested));
const platforms = JSON.parse(
  readFileSync(new URL("../packages/ghostmux/platforms.json", import.meta.url)),
);
const include = Object.entries(platforms).map(([platform, options]) => ({
  package: "ghostmux",
  platform,
  artifact: `ghostmux-${platform}`,
  ...options,
}));
include.push({
  package: "tree-sitter-wasm",
  platform: "wasm32-wasi",
  artifact: "tree-sitter-wasm",
  runner: "ubuntu-24.04",
});
console.log(
  JSON.stringify({
    include: include.filter(
      (entry) => requested === "all" || entry.package === requested,
    ),
  }),
);
