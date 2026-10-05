import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareReleaseSources } from "../packages/cli/scripts/release-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "cpi-editable-"));
const snapshot = await prepareReleaseSources(root, work);
const env = {
  ...process.env,
  BUN_INSTALL_GLOBAL_DIR: join(work, "global"),
  BUN_INSTALL_BIN: join(work, "bin"),
  BUN_INSTALL_CACHE_DIR: join(work, "cache"),
  CPI_CODING_AGENT_DIR: join(work, "agent"),
  CPI_RUNTIME: "",
  NODE_OPTIONS: "",
  NODE_PATH: "",
  PI_OFFLINE: "1",
};
function execute(command, args, cwd = work) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  await mkdir(env.CPI_CODING_AGENT_DIR);
  for (const directory of [
    "",
    "packages/cli",
    "packages/extensions",
    "packages/ghostmux",
    "packages/tree-sitter-wasm",
  ])
    await rm(join(snapshot.root, directory, "node_modules"), {
      recursive: true,
      force: true,
    });
  await copyFile(join(root, "bun.lock"), join(snapshot.root, "bun.lock"));
  const source = join(snapshot.root, "packages/cli");
  execute("bun", ["run", "install:dev"], snapshot.root);
  const launcher = join(env.BUN_INSTALL_BIN, "cpi");
  assert.equal(await realpath(launcher), join(source, "bin/cpi"));
  const original = execute(launcher, ["--version"]);
  const path = join(source, "src/cli.ts");
  const code = await readFile(path, "utf8");
  const tools = [
    ["@cpi/ghostmux", "packages/ghostmux/bin/ghostmux-resolve.mjs"],
    ["@cpi/tree-sitter-wasm", "packages/tree-sitter-wasm/index.ts"],
  ];
  const originals = await Promise.all(
    tools.map(([, file]) => readFile(join(snapshot.root, file), "utf8")),
  );
  for (const value of ["first edit", "second edit"]) {
    const checks = [];
    for (const [index, [name, file]] of tools.entries()) {
      await writeFile(
        join(snapshot.root, file),
        `${originals[index]}\nexport const editable_probe = ${JSON.stringify(value)};\n`,
      );
      checks.push(
        `import { editable_probe as probe_${index} } from "${name}"; if (probe_${index} !== ${JSON.stringify(value)}) throw new Error("Stale tool source");`,
      );
    }
    await writeFile(
      path,
      `${checks.join("\n")}\nif (!process.versions.bun) throw new Error("Expected Bun");\nconsole.log(${JSON.stringify(value)});\n${code}`,
    );
    assert.equal(execute(launcher, ["--version"]), `${value}\n${original}`);
  }
  console.log(
    "Clean Bun installation and development link run successive CLI, Ghostmux, and Tree-sitter source edits.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
