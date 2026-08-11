import { spawnSync } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 5000;

function normalizedSignal(signal: string | number): string | number {
  if (typeof signal === "number" || /^\d+$/.test(signal)) return Number(signal);
  return signal.startsWith("SIG")
    ? signal.toUpperCase()
    : `SIG${signal.toUpperCase()}`;
}

export function signalProcessTree(
  pid: number,
  signal: string | number,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const normalized = normalizedSignal(signal);
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, normalized as NodeJS.Signals);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}
