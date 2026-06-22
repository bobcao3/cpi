// One orchestrator tick (clidos-native): find cards ready for a stage agent,
// CLAIM each by posting a "Dispatched to <stage>" message to its thread (and
// moving Backlog -> PRD), then print one line per dispatch for the bash
// spawner:  <sessionId>\t<cardId>\t<stage>
//
// No external tracking file. The card's COLUMN is its stage; the LAST thread
// message is the in-flight claim. A card in stage X is dispatched iff its last
// message is NOT a fresh "Dispatched to X" claim. A stale claim (older than
// TUIDOS_STAGE_TIMEOUT_MS, default 15 min) means the worker likely died ->
// re-dispatch. Re-queue any card by archiving its claim message (it becomes
// unclaimed) or moving it back to its stage column.
//
// Bounded (TigerStyle): per-stage cap TUIDOS_ORCH_MAX_PER (default 2); one
// tick never spawns an unbounded herd.
import { listAllProjects } from "../core/db";
import { listColumns } from "../core/columns";
import { listTasks, moveTask, type TaskRow } from "../core/tasks";
import { listMessages, createMessage } from "../core/messages";

const TIMEOUT_MS = Number(process.env.TUIDOS_STAGE_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_PER = Number(process.env.TUIDOS_ORCH_MAX_PER) || 2;

const project = listAllProjects().find((p) => p.name === "tuidos");
if (!project) process.exit(0);
const pid = project.id;
const col = (name: string) => listColumns(pid).find((c) => c.name === name);

// column -> the stage agent that advances cards sitting in it. Backlog's agent
// is the PRD agent; dispatching it also moves the card Backlog -> PRD.
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
    createMessage(pid, t.id, "orchestrator", `Dispatched to ${w.stage} ${sid}.`);
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

/** A card is dispatchable for `stage` iff its last thread message is not a
 *  fresh "Dispatched to <stage>" claim. A stale claim (worker likely died) is
 *  treated as unclaimed -> re-dispatch. */
function shouldDispatch(pid: string, t: TaskRow, stage: string): boolean {
  const msgs = listMessages(pid, t.id);
  const last = msgs[msgs.length - 1];
  if (!last) return true;
  const prefix = `Dispatched to ${stage} `;
  if (!last.content.startsWith(prefix)) return true; // a deliverable / handoff
  // It's a claim for this stage: in flight unless stale.
  return Date.now() - last.created_at > TIMEOUT_MS;
}
