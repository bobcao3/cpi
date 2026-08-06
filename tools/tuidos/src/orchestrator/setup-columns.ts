// The board is the pipeline; column order is stage order.
import { listAllProjects } from "../core/db";
import {
  listColumns,
  createColumn,
  moveColumn,
  archiveColumn,
} from "../core/columns";
import { listTasks, moveTask } from "../core/tasks";

const project = listAllProjects().find((p) => p.name === "tuidos");
if (!project) {
  console.error("no tuidos project");
  process.exit(1);
}
const pid = project.id;

const have = (name: string) => listColumns(pid).find((c) => c.name === name);

// Legacy cards re-enter at Backlog; "In Progress" is retired.
const ip = have("In Progress");
const backlog = have("Backlog");
if (ip && backlog) {
  for (const t of listTasks(pid, ip.id)) {
    if (t.completed_at == null) moveTask(pid, t.id, backlog.id);
  }
}

for (const name of ["PRD", "Outline", "Implement", "Validate"]) {
  if (!have(name)) createColumn(pid, name);
}

// Keep stage columns in pipeline order.
const order = ["Backlog", "PRD", "Outline", "Implement", "Validate", "Done"];
for (let i = 0; i < order.length; i++) {
  const c = listColumns(pid).find((x) => x.name === order[i]);
  if (c) moveColumn(pid, c.id, i);
}

const ipAfter = listColumns(pid).find((c) => c.name === "In Progress");
if (ipAfter) archiveColumn(pid, ipAfter.id);

console.log("pipeline board ready:");
for (const c of listColumns(pid)) console.log(`  ${c.name}`);
