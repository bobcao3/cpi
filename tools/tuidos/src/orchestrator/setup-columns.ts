// Idempotently set up the tuidos pipeline board: Backlog -> PRD -> Outline ->
// Implement -> Validate -> Done, in that order. The board IS the pipeline
// (Basecamp card-table-through-phases): a card's column is its stage, its
// thread is the claim + stage deliverables. No external tracking file.
//
// Re-runnable. Moves any stragglers out of the legacy "In Progress" column to
// Backlog (so they re-enter the pipeline), then archives "In Progress".
import { listAllProjects } from "../core/db";
import { listColumns, createColumn, moveColumn, archiveColumn } from "../core/columns";
import { listTasks, moveTask } from "../core/tasks";

const project = listAllProjects().find((p) => p.name === "tuidos");
if (!project) { console.error("no tuidos project"); process.exit(1); }
const pid = project.id;

const have = (name: string) => listColumns(pid).find((c) => c.name === name);

// Move legacy "In Progress" stragglers back to Backlog so they re-enter the
// pipeline (the old single-stage monitor is gone).
const ip = have("In Progress");
const backlog = have("Backlog");
if (ip && backlog) {
  for (const t of listTasks(pid, ip.id)) {
    if (t.completed_at == null) moveTask(pid, t.id, backlog.id);
  }
}

// Create the four stage columns (idempotent: skip if a name already exists).
for (const name of ["PRD", "Outline", "Implement", "Validate"]) {
  if (!have(name)) createColumn(pid, name);
}

// Reorder to the pipeline order. Done is last; the legacy "In Progress" (if any)
// gets pushed past Done, then archived below.
const order = ["Backlog", "PRD", "Outline", "Implement", "Validate", "Done"];
for (let i = 0; i < order.length; i++) {
  const c = listColumns(pid).find((x) => x.name === order[i]);
  if (c) moveColumn(pid, c.id, i);
}

// Archive the now-empty legacy "In Progress" column.
const ipAfter = listColumns(pid).find((c) => c.name === "In Progress");
if (ipAfter) archiveColumn(pid, ipAfter.id);

console.log("pipeline board ready:");
for (const c of listColumns(pid)) console.log(`  ${c.name}`);
