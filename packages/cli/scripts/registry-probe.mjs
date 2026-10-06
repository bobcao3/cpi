import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

const installed = process.argv[2];
if (existsSync(join(installed, "source.mjs")))
  await import(pathToFileURL(join(installed, "source.mjs")));
const require = createRequire(join(installed, "package.json"));
async function load(path) {
  const url = pathToFileURL(path).href;
  if (!url.endsWith(".ts")) return import(url);
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, { tryNative: false }).import(url);
}
const manifest = JSON.parse(
  await readFile(join(installed, "package.json"), "utf8"),
);
const sdk = await load(join(installed, manifest.exports["."].import));
assert.equal(sdk.APP_NAME, "cpi");
const extensions = createRequire(
  JSON.parse(process.env.JITI_ALIAS || "{}")["@cpi/extensions/package.json"] ??
    require.resolve("@cpi/extensions/package.json"),
);
const aliases = JSON.parse(process.env.JITI_ALIAS || "{}");
const ghostmux = await load(
  aliases["@cpi/ghostmux"] ?? extensions.resolve("@cpi/ghostmux"),
);
const binary = await ghostmux.resolveGhostmux();
const native = JSON.parse(
  await readFile(join(dirname(binary), "../native.json"), "utf8"),
);
assert.equal(
  native.cpu_baseline,
  process.arch === "x64"
    ? "x86_64_v3"
    : process.platform === "darwin"
      ? "apple_m1"
      : "neoverse_n1",
);
const captured = spawnSync(binary, ["--history", "--join"], {
  input: "registry 中文\r\n",
  encoding: "utf8",
  timeout: 10000,
});
assert.ifError(captured.error);
assert.equal(captured.status, 0, captured.stderr);
assert.equal(captured.stdout, "registry 中文\n");
const wasm = await load(
  aliases["@cpi/tree-sitter-wasm"] ??
    extensions.resolve("@cpi/tree-sitter-wasm"),
);
const parsed = await wasm.parseCommand("printf registry");
assert.equal(parsed.available, true);
assert.equal(parsed.node.descendantsOfType("command_name")[0].text, "printf");
const settingsManager = sdk.SettingsManager.inMemory();
const loader = new sdk.DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.cwd(),
  settingsManager,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const host = await import(
  pathToFileURL(
    join(
      dirname(
        aliases["@cpi/extensions/package.json"] ??
          extensions.resolve("@cpi/extensions/package.json"),
      ),
      "bin/host-pi.mjs",
    ),
  )
);
assert.equal((await host.hostCodingAgent()).APP_NAME, "cpi");
const sandbox = new CodemodeSandbox();
try {
  const result = await sandbox.execute("text({installed:true}); return 7;");
  assert.equal(result.ok, true);
  assert.equal(result.value, 7);
  assert.equal(result.output[0].type, "json");
} finally {
  await sandbox.close();
}
console.log(
  "Registry-installed SDK, extensions, native binary, WASM, and codemode worker passed.",
);
