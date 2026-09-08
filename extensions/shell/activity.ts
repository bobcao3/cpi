import { beginActivity, finishActivity } from "../lib/activity.ts";
interface ShellObservation {
  activityId: string;
  startedAt: number;
  sessScope?: string;
  describe?: string;
  command: string;
  logPath: string;
  pid: number;
  bytesEmitted: number;
  cancelRequested?: boolean;
}
export function observeShell(
  entry: ShellObservation,
  cwd?: string,
  resumed = false,
): void {
  beginActivity({
    id: entry.activityId,
    kind: "shell",
    status: "running",
    session_id: entry.sessScope,
    label: entry.describe || entry.command,
    command: entry.command,
    cwd,
    started_at: entry.startedAt,
    log_path: entry.logPath,
    metrics: {
      pid: entry.pid,
      output_bytes: entry.bytesEmitted,
      resumed: resumed ? 1 : 0,
    },
  });
}
export function finishShell(
  entry: ShellObservation,
  exit_code: number,
  output_bytes: number,
): void {
  finishActivity(
    entry.activityId,
    entry.cancelRequested
      ? "cancelled"
      : exit_code === 0
        ? "completed"
        : "failed",
    { exit_code, output_bytes },
  );
}
