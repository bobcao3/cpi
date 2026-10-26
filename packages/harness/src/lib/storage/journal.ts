import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { sessionArtifactPath, type SessionOwner } from "./owner.ts";
import { read_scratch_record } from "./scratch-record.ts";

export { read_scratch_record as read_guardian_record };
export type GuardianRecord = ReturnType<typeof read_scratch_record>;

export async function pending_guardian_records(
  owner: SessionOwner,
  signal: AbortSignal,
  host_pid?: number,
): Promise<string[]> {
  const directory = await opendir(
    sessionArtifactPath(owner, "storage-guardian"),
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return [];
  const pending: string[] = [];
  let count = 0;
  try {
    for await (const entry of directory) {
      if (++count > 4096 || signal.aborted) {
        pending.push("guardian reconciliation incomplete");
        break;
      }
      if (!entry.name.endsWith(".json")) continue;
      const path = join(directory.path, entry.name);
      try {
        const record = read_scratch_record(path);
        if (
          record.session_id !== owner.session_id ||
          record.session_dir !== owner.session_dir
        )
          throw new Error("guardian owner mismatch");
        if (host_pid !== undefined && record.host_pid !== host_pid) continue;
        if (record.state !== "closed" && record.state !== "retained")
          pending.push(
            `${path}: ${record.state}${record.error_name ? `: ${record.error_name}` : ""}`,
          );
      } catch (error) {
        pending.push(
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return pending;
    pending.push(`guardian reconciliation failed: ${String(error)}`);
  }
  return pending;
}
