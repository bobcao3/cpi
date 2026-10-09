import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostCodingAgent } from "../../bin/host-pi.mjs";
import {
  acknowledgeShellRecord,
  readCompletedRecords,
  shellRecords,
  updateShellRecord,
  type CompletedRecord,
} from "./persistence.ts";
import { NOTIFICATION_TYPE } from "../lib/notification.ts";

export function completionDeliveryId(
  scope: string,
  record: Pick<CompletedRecord, "id" | "deliveryId">,
): string {
  return record.deliveryId ?? JSON.stringify([scope, record.id]);
}

async function persistedDeliveryIds(
  sessionFile: string | undefined,
  scope: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!sessionFile) return ids;
  try {
    const { SessionManager } = await hostCodingAgent();
    const manager = SessionManager.open(sessionFile);
    if (manager.getSessionId() !== scope) return ids;
    const entries = manager.getEntries();
    if (entries.length > 100_000)
      throw new Error("Shell notification history entry limit exceeded");
    for (const entry of entries) {
      if (
        entry.type !== "custom_message" ||
        entry.customType !== NOTIFICATION_TYPE
      )
        continue;
      const details = entry.details as
        | { kind?: string; deliveryId?: string }
        | undefined;
      if (
        ["completed-shells", "shell-complete", "shell-failed"].includes(
          details?.kind ?? "",
        ) &&
        typeof details?.deliveryId === "string"
      ) {
        ids.add(details.deliveryId);
      }
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
      acknowledgeShellRecord(scope, record.id);
    } else pending.push(record);
  }
  return pending;
}

export function acknowledgeShellNotifications(ctx: ExtensionContext): void {
  const scope = ctx.sessionManager.getSessionId();
  const pending = shellRecords(scope).filter(
    (record) => record.status !== "running" && !record.acknowledgedAt,
  );
  if (!pending.length) return;
  const delivered = new Set(
    ctx.sessionManager.getEntries().flatMap((entry) => {
      if (
        entry.type !== "custom_message" ||
        entry.customType !== NOTIFICATION_TYPE
      )
        return [];
      const id = (entry.details as { deliveryId?: string } | undefined)
        ?.deliveryId;
      return id ? [id] : [];
    }),
  );
  for (const record of pending) {
    const id = completionDeliveryId(scope, {
      id: record.id,
      deliveryId: record.legacyDeliveryId,
    });
    if (delivered.has(id))
      updateShellRecord(record.id, { acknowledgedAt: Date.now() });
  }
}
