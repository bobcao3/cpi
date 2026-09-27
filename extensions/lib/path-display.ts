/** Shortest display form of a path: cwd-relative, ~/-relative, or absolute. */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

function under(path: string, root: string): string | undefined {
  const tail = relative(root, path);
  if (tail === "") return "";
  if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail))
    return undefined;
  return tail.split(sep).join("/");
}

export function displayPath(input: string, cwd: string): string {
  const base = cwd || process.cwd();
  const absolute = resolve(base, input);
  const here = under(absolute, base);
  const home = under(absolute, homedir());
  const candidates: string[] = [];
  if (here !== undefined) candidates.push(here || ".");
  if (home !== undefined) candidates.push(home ? `~/${home}` : "~");
  candidates.push(absolute);
  return candidates.reduce((best, next) =>
    next.length < best.length ? next : best,
  );
}
