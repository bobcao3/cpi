import type { Worker } from "node:worker_threads";
import type { SubagentWorkerRequest } from "./subagent-rpc-protocol.ts";
import { beginActivity } from "./activity.ts";

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
    const title =
      "title" in request &&
      typeof request.title === "string" &&
      request.title.length > 0
        ? request.title
        : task.slice(0, 240);
    beginActivity({
      id: request.runId,
      kind: "subagent",
      status: "running",
      session_id:
        "parentSessionId" in request
          ? request.parentSessionId
          : request.env.PI_SESSION_ID,
      label: `${role || ("kind" in request ? request.kind : "subagent")}: ${title}`,
      cwd: request.cwd,
      started_at: Date.now(),
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
  } catch {}
}
