import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { sessionArtifactPath, type SessionOwner } from "./owner.ts";

export interface GuardianRecord {
  version: number;
  state: string;
  session_id: string;
  session_dir: string;
  host_pid: number;
  path: string;
  error_name?: string | null;
  closure_evidence?: string;
  host_closed?: boolean;
  scope_removed?: boolean;
}
export async function read_guardian_record(
  path: string,
): Promise<GuardianRecord> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 32768 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error(`unsafe guardian journal: ${path}`);
    const buffer = Buffer.alloc(32769);
    let length = 0;
    for (let reads = 0; reads < 32769; reads++) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      length += bytesRead;
      if (!bytesRead) break;
      if (length === buffer.length)
        throw new Error(`oversized guardian journal: ${path}`);
    }
    const value = JSON.parse(
      buffer.subarray(0, length).toString("utf8"),
    ) as GuardianRecord;
    if (
      value.version !== 1 ||
      !["pending", "closed", "retained"].includes(value.state) ||
      typeof value.path !== "string" ||
      typeof value.session_id !== "string" ||
      typeof value.session_dir !== "string" ||
      !Number.isSafeInteger(value.host_pid) ||
      value.host_pid <= 1 ||
      !["none", "controller_close", "pidfd_exit"].includes(
        value.closure_evidence ?? "",
      ) ||
      (value.closure_evidence === "pidfd_exit" && value.host_closed !== true) ||
      (value.state !== "pending" && value.closure_evidence === "none") ||
      (value.state === "closed" && value.scope_removed !== true)
    )
      throw new Error(`invalid guardian journal: ${path}`);
    return value;
  } finally {
    await file.close();
  }
}
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
        const record = await read_guardian_record(path);
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
    pending.push(`guardian reconciliation failed: ${String(error)}`);
  }
  return pending;
}
