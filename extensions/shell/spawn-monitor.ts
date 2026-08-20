import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeSpawn } from "../lib/runtime.ts";
import { type ShellProfile } from "./profile.ts";

const SH_MONITOR_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tools",
  "sh-monitor",
  "sh-monitor.ts",
);

export interface SpawnedMonitor {
  child: ChildProcess;
  logPath: string;
  runtimeBin: string;
}

export function spawnMonitor(
  command: string,
  env: NodeJS.ProcessEnv,
  pathId: string,
  shell: ShellProfile,
  cwd: string,
): SpawnedMonitor {
  const logPath = join(tmpdir(), `pi-sh-output-${pathId}.log`);
  const { bin, pre } = runtimeSpawn();
  const child = spawn(
    bin,
    [
      ...pre,
      SH_MONITOR_TS,
      "spawn",
      logPath,
      "--",
      shell.executable,
      ...shell.commandArgs(command),
    ],
    {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      windowsHide: true,
    },
  );
  child.unref();
  return { child, logPath, runtimeBin: bin };
}
