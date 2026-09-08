import type { Worker } from "node:worker_threads";
import type { SubagentWorkerRequest } from "./subagent-rpc-protocol.ts";
import {
  appendActivityTail,
  beginActivity,
  updateActivity,
} from "./activity.ts";
import { parseSummaryUsage } from "./cost-ledger.ts";

export function subagentEnvironment(
  request: SubagentWorkerRequest,
  endpoint: string,
) {
  const env: Record<string, string> = {
    ...request.env,
    CPI_SUBAGENT_RPC: endpoint,
    PI_SUBAGENT: "1",
    CPI_ACTIVITY_TELEMETRY: "1",
  };
  if ("kind" in request && request.kind === "fork-probe") {
    env.CPI_FORK_PROBE = "1";
    env.PI_SESSION_ID = request.parentSessionId;
    env.PI_SESSION = request.parentSessionId.slice(0, 8);
    env.PI_SESSION_DIR = request.sessionDir;
    delete env.PI_SUBAGENT_COMPLETION;
    delete env.PI_SUBAGENT_ROLE;
    delete env.PI_SUBAGENT_CWD;
    delete env.PI_SUBAGENT_SUMMARY;
  }
  return env;
}

export function observeSubagent(
  request: SubagentWorkerRequest,
  worker: Worker,
): void {
  try {
    const role = request.env.PI_SUBAGENT_ROLE;
    const task = "task" in request ? request.task : request.prompt;
    beginActivity({
      id: request.runId,
      kind: "subagent",
      status: "running",
      session_id:
        "parentSessionId" in request
          ? request.parentSessionId
          : request.env.PI_SESSION_ID,
      label: `${role || ("kind" in request ? request.kind : "subagent")}: ${task.slice(0, 240)}`,
      cwd: request.cwd,
      started_at: Date.now(),
      log_path: role ? undefined : request.env.CPI_ACTIVITY_SHELL_LOG,
      metrics: {
        worker_thread: worker.threadId,
        usage_scope: "self",
        ...(role ? { role } : {}),
        ...("modelId" in request
          ? {
              model: `${request.provider}/${request.modelId}`,
              effort: request.thinkingLevel ?? "",
            }
          : {}),
      },
    });
    let summaryTail = "";
    let bytes = 0;
    worker.stderr.on("data", (chunk: Buffer) => {
      try {
        const text = chunk.toString("utf8");
        bytes += chunk.length;
        summaryTail = (summaryTail + text).slice(-32768);
        appendActivityTail(request.runId, text);
        updateActivity(request.runId, { metrics: { output_bytes: bytes } });
      } catch {}
    });
    worker.stdout.on("data", (chunk: Buffer) => {
      try {
        summaryTail = (summaryTail + chunk.toString("utf8")).slice(-32768);
        bytes += chunk.length;
        updateActivity(request.runId, { metrics: { output_bytes: bytes } });
      } catch {}
    });
    worker.once("exit", () => {
      try {
        const usage = parseSummaryUsage(summaryTail);
        if (usage) {
          updateActivity(request.runId, {
            metrics: {
              input: usage.input,
              output: usage.output,
              cost: usage.cost,
              usage_scope: "subtree",
            },
          });
        }
      } catch {}
    });
  } catch {}
}
export function observeSubagentMessage(id: string, message: unknown): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    !("kind" in message) ||
    message.kind !== "activity"
  )
    return false;
  try {
    const value = message as { metrics?: Record<string, string | number> };
    const metrics: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(value.metrics ?? {}).slice(
      0,
      24,
    )) {
      if (
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item))
      )
        metrics[key] = item;
    }
    updateActivity(id, { metrics });
  } catch {}
  return true;
}
