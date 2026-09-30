import { readFile } from "node:fs/promises";
import { NOTIFICATION_TYPE } from "../lib/notification.ts";
import {
  readCompletedRecords,
  removeCompletedRecord,
  type CompletedRecord,
} from "./monitor.ts";

export function completionDeliveryId(
  scope: string,
  record: CompletedRecord,
): string {
  return JSON.stringify([scope, record.pid, record.completedAt]);
}

async function persistedDeliveryIds(
  sessionFile: string | undefined,
  scope: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!sessionFile) return ids;
  try {
    const lines = (await readFile(sessionFile, "utf8")).split("\n");
    const header = JSON.parse(lines.shift()!);
    if (header.type !== "session" || header.id !== scope) return ids;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (
          entry.type === "custom_message" &&
          entry.customType === NOTIFICATION_TYPE &&
          entry.details?.kind === "completed-shells" &&
          typeof entry.details.deliveryId === "string"
        ) {
          ids.add(entry.details.deliveryId);
        }
      } catch {}
    }
  } catch {}
  return ids;
}

export async function pendingCompletedRecords(
  sessionDir: string,
  scope: string,
  sessionFile: string | undefined,
): Promise<CompletedRecord[]> {
  const delivered = await persistedDeliveryIds(sessionFile, scope);
  const pending: CompletedRecord[] = [];
  for (const record of await readCompletedRecords(sessionDir, scope)) {
    if (delivered.has(completionDeliveryId(scope, record))) {
      await removeCompletedRecord(sessionDir, scope, record.pid);
    } else pending.push(record);
  }
  return pending;
}
