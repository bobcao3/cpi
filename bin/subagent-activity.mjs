import { parentPort } from "node:worker_threads";

export function observeSession(session) {
  if (process.env.CPI_ACTIVITY_TELEMETRY !== "1") return () => {};
  let turns = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  const publish = (extra = {}) => {
    try {
      parentPort?.postMessage({
        kind: "activity",
        metrics: {
          model: session.model ? `${session.model.provider}/${session.model.id}` : "unknown",
          effort: session.thinkingLevel ?? "",
          session_file: session.sessionFile ?? "",
          child_session_id: session.sessionId,
          turns, input, output, cost,
          ...extra,
        },
      });
    } catch {}
  };
  publish();
  try {
    const unsubscribe = session.subscribe((event) => {
      try {
    if (event.type === "turn_end") turns++;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const usage = event.message.usage;
      input += usage?.input ?? 0;
      output += usage?.output ?? 0;
      cost += usage?.cost?.total ?? 0;
    }
    if (["turn_end", "message_end", "tool_execution_start", "tool_execution_end", "auto_retry_start", "auto_retry_end"].includes(event.type)) publish({ last_event_at: Date.now(), phase: event.type });
      } catch {}
    });
    return () => { try { unsubscribe(); } catch {} };
  } catch {
    return () => {};
  }
}
