import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { ScriptTarget } from "typescript/unstable/ast";
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
const fork = process.env.CPI_FORK
  ? resolve(process.cwd(), process.env.CPI_FORK)
  : null;
if (fork) {
  const configPath = join(root, "tsconfig.editable-check.json");
  let virtualConfig;
  const api = new API({
    cwd: root,
    fs: {
      readFile: (file) => (file === configPath ? virtualConfig : undefined),
      fileExists: (file) => (file === configPath ? true : undefined),
    },
  });
  let snapshot;
  try {
    const rootConfig = api.parseConfigFile(join(root, "tsconfig.json"));
    const forkConfig = api.parseConfigFile(join(fork, "tsconfig.json"));
    readFileSync(join(fork, "packages/coding-agent/src/index.ts"), "utf8");
    const paths = Object.fromEntries(
      Object.entries(forkConfig.options.paths ?? {}).map(([key, targets]) => [
        key,
        targets.map((target) =>
          resolve(forkConfig.options.pathsBasePath ?? fork, target),
        ),
      ]),
    );
    const target = Math.max(
      rootConfig.options.target ?? ScriptTarget.ESNext,
      forkConfig.options.target ?? ScriptTarget.ESNext,
    );
    virtualConfig = JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        target:
          target === ScriptTarget.ESNext ? "ESNext" : ScriptTarget[target],
        paths,
      },
    });
    console.log(`Checking cpi against editable fork ${fork}`);
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const program = snapshot.getProject(configPath)?.program;
    if (!program) throw new Error("Editable check project did not load");
    // The fork must use its own compiler settings to check its source files.
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getBindDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((diagnostic) => {
      if (!diagnostic.fileName) return true;
      const local = relative(root, diagnostic.fileName);
      return local.split(/[\\/]/)[0] !== ".." && !isAbsolute(local);
    });
    for (const diagnostic of diagnostics) {
      const pending = [diagnostic];
      let visited = 0;
      while (pending.length) {
        if (++visited > 10000)
          throw new Error("Diagnostic detail limit exceeded");
        const detail = pending.pop();
        const file = detail.fileName && program.getSourceFile(detail.fileName);
        const position =
          file && detail.pos >= 0
            ? file.getLineAndCharacterOfPosition(detail.pos)
            : undefined;
        const location = detail.fileName
          ? `${relative(root, detail.fileName)}${position ? `:${position.line + 1}:${position.character + 1}` : ""}`
          : "<configuration>";
        console.error(`${location}: TS${detail.code}: ${detail.text}`);
        pending.push(
          ...[
            ...(detail.messageChain ?? []),
            ...(detail.relatedInformation ?? []),
          ].reverse(),
        );
      }
    }
    failures += diagnostics.length;
  } finally {
    snapshot?.dispose();
    api.close();
  }
} else {
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
    const entry = realpathSync(
      fileURLToPath(import.meta.resolve(`@earendil-works/${name}`)),
    );
    const local = relative(join(root, "node_modules"), entry);
    if (local.startsWith("..") || isAbsolute(local)) {
      throw new Error(`Expected installed ${name}, resolved ${entry}`);
    }
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
if (!fork) {
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", "tsconfig.json", "--noEmit"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) failures++;
}
const formatResult = spawnSync(
  process.execPath,
  [join(root, "scripts/format.mjs"), "--check"],
  { cwd: root, stdio: "inherit" },
);
if (formatResult.error) throw formatResult.error;
if (formatResult.status !== 0) failures++;
process.exitCode = failures ? 1 : 0;
