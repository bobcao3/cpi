import { execFile, spawnSync } from "child_process";

const commandOptions = {
  encoding: "utf8" as const,
  timeout: 2000,
  maxBuffer: 64 * 1024,
  killSignal: "SIGKILL" as const,
  windowsHide: true,
};

export function readVcsCommandSync(
  command: string,
  args: string[],
  cwd: string,
): string | null {
  const result = spawnSync(command, args, {
    ...commandOptions,
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function readVcsCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...commandOptions, cwd, signal },
      (error, stdout) => {
        resolve(error ? null : stdout.trim() || null);
      },
    );
  });
}
