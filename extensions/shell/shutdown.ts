import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  NOTIFICATION_TYPE,
  wrapNotification,
  type NotificationDetails,
} from "../lib/notification.ts";
import { loadText, render, textPath } from "../lib/text.ts";

interface ShutdownAction {
  id: string;
  command: string;
  log_path: string;
  kind: "shell" | "repeat";
  describe?: string;
}
interface ShutdownRecord extends ShutdownAction {
  interrupted_at: number;
}

function record_directory(session_dir: string, scope: string): string {
  return join(session_dir, "sh-mon", scope, "shutdown");
}

export function record_shell_shutdown(
  session_dir: string | undefined,
  scope: string | undefined,
  action: ShutdownAction,
): void {
  if (!session_dir || !scope) return;
  try {
    const directory = record_directory(session_dir, scope);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.json`);
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify({ ...action, interrupted_at: Date.now() }) + "\n",
      {
        flag: "wx",
        mode: 0o600,
        flush: true,
      },
    );
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error(error);
  }
}

export async function surface_shell_shutdowns(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const session_dir = ctx.sessionManager.getSessionDir();
  const scope = ctx.sessionManager.getSessionId();
  if (!session_dir || !scope) return;
  const directory = record_directory(session_dir, scope);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const delivered = new Set(
    ctx.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom_message" &&
        entry.customType === NOTIFICATION_TYPE
          ? [(entry.details as { shutdown_record?: string })?.shutdown_record]
          : [],
      ),
  );
  const text = loadText<{ shutdown: { summary: string; guidance: string } }>(
    "shell",
    textPath("shell"),
  ).shutdown;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(directory, file);
    if (!delivered.has(file)) {
      const record = JSON.parse(await readFile(path, "utf8")) as ShutdownRecord;
      const summary = render(text.summary, { ...record });
      const details: NotificationDetails & { shutdown_record: string } = {
        kind: "interrupted-shells",
        summary,
        shutdown_record: file,
        payload: { ...record, summary, guidance: text.guidance },
      };
      pi.sendMessage({
        customType: NOTIFICATION_TYPE,
        content: wrapNotification(details),
        display: true,
        details,
      });
      const persisted = ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === NOTIFICATION_TYPE &&
            (entry.details as { shutdown_record?: string })?.shutdown_record ===
              file,
        );
      if (!persisted) continue;
    }
    await unlink(path);
  }
}
