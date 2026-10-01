import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const windows = process.platform === "win32";
export const shellCommand = (posix, powershell) =>
  windows ? powershell : posix;
export async function nodeProgram(directory, name, source) {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, source);
  const quote = (value) =>
    `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
  return `${windows ? "& " : ""}${quote(process.execPath)} ${quote(path)}`;
}
