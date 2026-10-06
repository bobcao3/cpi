import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  sourceMetrics,
  withSourceFiles,
} from "../packages/extensions/scripts/source-metrics.mjs";
import { root, sourceFiles } from "./source-files.mjs";

const require = createRequire(import.meta.url);
const compiler = join(
  dirname(require.resolve("typescript/package.json")),
  "bin/tsc",
);
let failures = 0;
const repository = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspaces = repository.workspaces.map((folder) =>
  JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")),
);
const local_names = new Set(workspaces.map((manifest) => manifest.name));
for (const manifest of workspaces)
  for (const field of ["dependencies", "optionalDependencies"])
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (local_names.has(name)) continue;
      if (repository[field]?.[name] !== spec)
        throw new Error(
          `GitHub installation lacks ${manifest.name}'s ${name}@${spec}`,
        );
    }
for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
  const entry = realpathSync(
    fileURLToPath(import.meta.resolve(`@earendil-works/${name}`)),
  );
  const local = relative(join(root, "node_modules"), entry);
  if (local.startsWith("..") || isAbsolute(local)) {
    throw new Error(`Expected installed ${name}, resolved ${entry}`);
  }
}
withSourceFiles(
  sourceFiles().map((file) => join(root, file)),
  (path, source) => {
    const file = relative(root, path);
    const comments = sourceMetrics(source);
    const { sourceLines, statements } = comments;
    const problems = [];
    if (sourceLines > 397) problems.push(`${sourceLines} source lines > 397`);
    if (statements > 355) problems.push(`${statements} AST statements > 355`);
    if (comments.commentLines / comments.totalLines > 0.07) {
      problems.push(
        `${((100 * comments.commentLines) / comments.totalLines).toFixed(1)}% comment lines > 7%`,
      );
    }
    if (problems.length) {
      console.error(`${file}: ${problems.join(", ")}`);
      failures++;
    }
  },
);
for (const args of [
  [compiler, "-p", "tsconfig.json", "--noEmit"],
  [join(root, "scripts/format.mjs"), "--check"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failures++;
}
process.exitCode = failures ? 1 : 0;
