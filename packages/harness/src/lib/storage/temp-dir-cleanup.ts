import type { SessionOwner } from "./owner.ts";
import { diagnostic } from "./temp-dir-records.ts";
import {
  inventory_temp_directories,
  pending_temp_directories,
  release_temp_directory,
} from "./temp-dirs.ts";

export async function cleanup_temp_directories(
  owner: SessionOwner,
  signal: AbortSignal,
): Promise<string[]> {
  const inventory = await inventory_temp_directories(owner);
  if (inventory.inventory_errors.length) return pending_temp_directories(owner);
  const pending: string[] = [];
  for (const directory of inventory.directories) {
    if (directory.type !== "scratch") continue;
    if (signal.aborted) {
      pending.push(
        `${directory.path}: automatic scratch cleanup deadline reached`,
      );
      continue;
    }
    try {
      await release_temp_directory(owner, directory.id, true);
    } catch (error) {
      pending.push(`${directory.path}: ${diagnostic(error)}`);
    }
  }
  return [...new Set([...pending, ...(await pending_temp_directories(owner))])];
}
