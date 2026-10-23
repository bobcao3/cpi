import { socket_directory } from "./storage/paths.ts";

export function resolveRuntimeDir(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "win32") return null;
  try {
    return socket_directory("subagent", "cpi-subagent.sock", { env });
  } catch {
    return null;
  }
}
