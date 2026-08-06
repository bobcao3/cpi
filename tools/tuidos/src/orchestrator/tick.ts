import { listAllProjects } from "../core/db";
import { listColumns } from "../core/columns";
import { listTasks, moveTask, type TaskRow } from "../core/tasks";
import { listMessages, createMessage } from "../core/messages";

// Cap dispatches per stage to bound spawned workers.
const TIMEOUT_MS =
  Number(process.env.TUIDOS_STAGE_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_PER = Number(process.env.TUIDOS_ORCH_MAX_PER) || 2;

const project = listAllProjects().find((p) => p.name === "tuidos");
if (!project) process.exit(0);
const pid = project.id;
const col = (name: string) => listColumns(pid).find((c) => c.name === name);

// Backlog is dispatched to PRD and moved into PRD.
const WATCH: { col: string; stage: string; moveTo?: string }[] = [
  { col: "Backlog", stage: "PRD", moveTo: "PRD" },
  { col: "PRD", stage: "PRD" },
  { col: "Outline", stage: "Outline" },
  { col: "Implement", stage: "Implement" },
  { col: "Validate", stage: "Validate" },
];

let total = 0;
for (const w of WATCH) {
  const c = col(w.col);
  if (!c) continue;
  let perStage = 0;
  for (const t of listTasks(pid, c.id)) {
    if (t.completed_at != null) continue;
    if (perStage >= MAX_PER) break;
    if (!shouldDispatch(pid, t, w.stage)) continue;

    const sid = `worker-${t.id}-${w.stage}-${Date.now()}`;
    createMessage(
      pid,
      t.id,
      "orchestrator",
      `Dispatched to ${w.stage} ${sid}.`,
    );
    if (w.moveTo) {
      const mv = col(w.moveTo);
      if (mv) moveTask(pid, t.id, mv.id);
    }
    console.log(`${sid}\t${t.id}\t${w.stage}`);
    perStage++;
    total++;
  }
}
if (total === 0) console.error("tick: nothing to dispatch");

/** Dispatch only when the latest stage claim is absent or stale. */
function shouldDispatch(pid: string, t: TaskRow, stage: string): boolean {
  const msgs = listMessages(pid, t.id);
  const last = msgs[msgs.length - 1];
  if (!last) return true;
  const prefix = `Dispatched to ${stage} `;
  if (!last.content.startsWith(prefix)) return true;
  return Date.now() - last.created_at > TIMEOUT_MS;
}
