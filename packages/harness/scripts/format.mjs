const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  throw new Error("expected --write or --check");
}

const listed = Bun.spawnSync(["jj", "file", "list"], {
  stdout: "pipe",
  stderr: "inherit",
});
if (listed.exitCode !== 0) process.exit(listed.exitCode);

const ignorePaths = listed.stdout
  .toString()
  .split("\n")
  .filter((path) => path === ".gitignore" || path.endsWith("/.gitignore"));
if (!ignorePaths.includes(".gitignore") || ignorePaths.length > 256) {
  throw new Error(`invalid gitignore count: ${ignorePaths.length}`);
}

const command = [
  process.execPath,
  "run",
  "prettier",
  mode,
  ...ignorePaths.flatMap((path) => ["--ignore-path", path]),
  "**/*.{ts,js,mjs,cjs,json,jsonc,md}",
];
const formatted = Bun.spawnSync(command, {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(formatted.exitCode);
