import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as prettier from "prettier";
import { root, sourceFiles } from "./source-files.mjs";

const mode = process.argv[2];
if (!["--check", "--write"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/format.mjs --check|--write");
}
const files = [...sourceFiles(), "tsconfig.json", ".prettierrc"];
let failures = 0;
for (const file of files) {
  const filepath = join(root, file);
  const source = await readFile(filepath, "utf8");
  const options = { ...(await prettier.resolveConfig(filepath)), filepath };
  if (mode === "--write") {
    const formatted = await prettier.format(source, options);
    if (formatted !== source) {
      await writeFile(filepath, formatted);
      console.log(file);
    }
  } else if (!(await prettier.check(source, options))) {
    console.error(file);
    failures++;
  }
}
if (failures) {
  console.error(`${failures} file(s) need formatting`);
  process.exitCode = 1;
}
