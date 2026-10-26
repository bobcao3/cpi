import { lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  directory_identity,
  private_directory,
  same_identity,
  sync_private_directory,
  type DirectoryIdentity,
} from "./temp-dir-records.ts";

const MAX_DEPTH = 32;
const MAX_ENTRIES = 10000;

interface Frame {
  path: string;
  names: string[];
  index: number;
  dev: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function names(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).map((entry) => entry.name);
}

export function remove_scratch_scope(
  root: string,
  root_identity: DirectoryIdentity,
  path: string,
  identity: DirectoryIdentity,
): void {
  const root_stat = private_directory(root);
  if (!same_identity(root_stat, root_identity))
    throw new Error("scratch root identity changed");
  let scope;
  try {
    scope = lstatSync(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (
    !scope.isDirectory() ||
    scope.isSymbolicLink() ||
    !same_identity(scope, identity)
  )
    throw new Error("scratch scope identity changed");
  const stack: Frame[] = [
    { path, names: names(path), index: 0, dev: String(scope.dev) },
  ];
  let entries = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.names.length) {
      rmdirSync(frame.path);
      stack.pop();
      continue;
    }
    const name = frame.names[frame.index]!;
    frame.index += 1;
    if (++entries > MAX_ENTRIES)
      throw new Error("scratch cleanup limit reached");
    const child = join(frame.path, name);
    let stat;
    try {
      stat = lstatSync(child, { bigint: true });
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (String(stat.dev) !== frame.dev)
        throw new Error("scratch contains a nested mount");
      if (stack.length >= MAX_DEPTH)
        throw new Error("scratch cleanup depth limit reached");
      stack.push({
        path: child,
        names: names(child),
        index: 0,
        dev: frame.dev,
      });
    } else {
      rmSync(child, { force: false });
    }
  }
  try {
    lstatSync(path);
  } catch (error) {
    if (missing(error)) {
      sync_private_directory(root);
      return;
    }
    throw error;
  }
  throw new Error("scratch scope remains after cleanup");
}

export function scratch_root_identity(path: string): DirectoryIdentity {
  return directory_identity(private_directory(path));
}
