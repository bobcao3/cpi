import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  )
    return join(homedir(), configured.slice(2));
  if (configured.startsWith("file://")) return fileURLToPath(configured);
  return configured;
}
