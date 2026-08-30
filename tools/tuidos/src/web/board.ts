import { listColumns } from "../core/columns";
import { listTasks, type TaskRow } from "../core/tasks";
import { dueDate, priorityLabel } from "./format";
import { enc, escapeHtml, htmxDialogForm, htmxForm, type Notice } from "./html";
import { projectById, workspace } from "./layout";

const COLUMN_LIMIT = 64;
const TASK_LIMIT = 500;

function taskMatches(task: TaskRow, query: string): boolean {
  if (!query) return true;
  return `${task.title}\n${task.description ?? ""}\n${task.assignee ?? ""}`
    .toLocaleLowerCase()
    .includes(query);
}

function shortLabels(tasks: TaskRow[]): Map<string, string> {
  const lengths = [6, 7, 8, 9, 10, 11, 12];
  const counts = lengths.map((length) => {
    const prefixes = new Map<string, number>();
    for (const task of tasks) {
      const prefix = task.id.slice(0, length).toUpperCase();
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    return prefixes;
  });
  return new Map(
    tasks.map((task) => {
      const label =
        lengths
          .map((length, index) => ({
            length,
            count: counts[index]!.get(task.id.slice(0, length).toUpperCase()),
          }))
          .find(({ count }) => count === 1)?.length ?? task.id.length;
      return [task.id, task.id.slice(0, label).toUpperCase()];
    }),
  );
}

function taskCard(
  projectId: string,
  task: TaskRow,
  shortLabel: string,
  previousColumn: string | undefined,
  nextColumn: string | undefined,
): string {
  const base = `/projects/${enc(projectId)}/tasks/${enc(task.id)}`;
  const move = (columnId: string | undefined, label: string, glyph: string) =>
    columnId
      ? `<form action="${base}/move" method="post" hx-post="${base}/move" ${htmxForm}><input type="hidden" name="column" value="${columnId}"><button class="icon-button" type="submit" aria-label="${label}" title="${label}">${glyph}</button></form>`
      : `<button class="icon-button" type="button" disabled aria-label="${label}">${glyph}</button>`;
  const priority = priorityLabel(task.priority);
  const due = dueDate(task.due_at);
  return `<article class="task-card bevel${task.completed_at == null ? "" : " is-done"}" id="task-${task.id}"><a class="task-link" href="${base}" hx-get="${base}" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true"><span class="task-id">${shortLabel}</span><h3>${escapeHtml(task.title)}</h3>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}<div class="task-meta">${priority ? `<span class="priority priority-${task.priority}">${priority}</span>` : ""}${task.assignee ? `<span>@${escapeHtml(task.assignee)}</span>` : ""}${due ? `<time datetime="${due}">Due ${due}</time>` : ""}${task.completed_at != null ? "<strong>Done</strong>" : ""}</div></a><div class="card-controls">${move(previousColumn, "Move left", "←")}${move(nextColumn, "Move right", "→")}<form action="${base}/completion" method="post" hx-post="${base}/completion" ${htmxForm}><input type="hidden" name="surface" value="board"><input type="hidden" name="completed" value="${task.completed_at == null ? "1" : "0"}"><button class="icon-button" type="submit" aria-label="${task.completed_at == null ? "Complete" : "Reopen"}" title="${task.completed_at == null ? "Complete" : "Reopen"}">${task.completed_at == null ? "✓" : "↺"}</button></form><form action="${base}/archive" method="post" hx-post="${base}/archive" ${htmxForm} hx-confirm="Archive ‘${escapeHtml(task.title)}’? You can restore it from the confirmation banner."><button class="icon-button danger" type="submit" aria-label="Archive" title="Archive">×</button></form></div></article>`;
}

export function renderBoard(
  projectId: string,
  rawQuery = "",
  notice?: Notice,
  restoreTaskId?: string,
): string {
  const project = projectById(projectId);
  const query = rawQuery.trim().toLocaleLowerCase().slice(0, 128);
  const queriedColumns = listColumns(projectId, COLUMN_LIMIT + 1);
  const columns = queriedColumns.slice(0, COLUMN_LIMIT);
  const allTasks = listTasks(projectId, undefined, 100_001);
  const bounded =
    queriedColumns.length > COLUMN_LIMIT || allTasks.length > 100_000;
  const labels = shortLabels(allTasks);
  const tasksByColumn = new Map<string, TaskRow[]>();
  for (const task of allTasks) {
    const tasks = tasksByColumn.get(task.column_id);
    if (tasks) tasks.push(task);
    else tasksByColumn.set(task.column_id, [task]);
  }
  const rendered = columns
    .map((column, index) => {
      const tasks = (tasksByColumn.get(column.id) ?? [])
        .filter((task) => taskMatches(task, query))
        .slice(0, TASK_LIMIT);
      const cards = tasks
        .map((task) =>
          taskCard(
            projectId,
            task,
            labels.get(task.id) ?? task.id,
            columns[index - 1]?.id,
            columns[index + 1]?.id,
          ),
        )
        .join("");
      const formUrl = `/projects/${enc(projectId)}/task-form?column=${enc(column.id)}`;
      const editUrl = `/projects/${enc(projectId)}/columns/${enc(column.id)}/edit`;
      const moveUrl = `/projects/${enc(projectId)}/columns/${enc(column.id)}/move`;
      return `<section class="board-column window" data-column-id="${enc(column.id)}"><div class="column-bar" tabindex="0" aria-label="Drag to reorder ${escapeHtml(column.name)}"><h2>${escapeHtml(column.name)}</h2><div class="column-actions"><span>${tasks.length}</span><button class="icon-button" type="button" aria-label="Edit column" title="Edit column" hx-get="${editUrl}" hx-target="#modal-body" command="show-modal" commandfor="modal">✎</button></div></div><form class="column-reorder-form" action="${moveUrl}" method="post" hx-post="${moveUrl}" ${htmxForm}><input type="hidden" name="position" value="${index}"></form><div class="column-body">${cards || `<div class="column-empty">${query ? "No matches" : "Drop the next idea here"}</div>`}<button class="add-card bevel" type="button" hx-get="${formUrl}" hx-target="#modal-body" command="show-modal" commandfor="modal">＋ Add card</button></div></section>`;
    })
    .join("");
  const q = rawQuery.trim().slice(0, 128);
  const filterFooter = `<footer class="filterbar"><label class="footer-search" for="board-filter"><span>Filter cards</span><input id="board-filter" type="search" name="q" value="${escapeHtml(q)}" placeholder="title, description, assignee" hx-get="/projects/${enc(projectId)}" hx-trigger="input changed delay:250ms" hx-target="#workspace" hx-swap="outerMorph" hx-push-url="true" hx-indicator="#activity-indicator"></label></footer>`;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (restoreTaskId) params.set("restore", restoreTaskId);
  const path = `/projects/${enc(projectId)}${params.toString() ? `?${params}` : ""}`;
  const body = `${bounded ? `<p class="form-note">The browser view is bounded; clidos can access remaining records.</p>` : ""}<section class="board" aria-label="Task board">${rendered}<button class="column-placeholder" type="button" hx-get="/projects/${enc(projectId)}/column-form" hx-target="#modal-body" command="show-modal" commandfor="modal">＋ Add column</button></section>`;
  return workspace(body, {
    title: project.name,
    path,
    project,
    active: "board",
    notice,
    poll: true,
    footer: filterFooter,
  });
}

export function renderColumnForm(projectId: string): string {
  const project = projectById(projectId);
  const action = `/projects/${enc(projectId)}/columns`;
  return `<form class="form-stack" action="${action}" method="post" hx-post="${action}" ${htmxDialogForm} hx-indicator="#activity-indicator"><h2>New column</h2><label>Name<input name="name" required maxlength="64" autofocus autocomplete="off"></label><div class="dialog-actions"><button type="button" command="close" commandfor="modal">Cancel</button><button class="primary bevel" type="submit">Add column</button></div><p class="form-note">The new column will be appended to ${escapeHtml(project.name)}.</p></form>`;
}

export function renderColumnEditor(
  projectId: string,
  columnId: string,
): string {
  projectById(projectId);
  const column = listColumns(projectId).find((item) => item.id === columnId);
  if (!column)
    throw new Error(
      "column is unavailable — refresh the board and choose an active column",
    );
  const renameAction = `/projects/${enc(projectId)}/columns/${enc(column.id)}/rename`;
  const archiveAction = `/projects/${enc(projectId)}/columns/${enc(column.id)}/archive`;
  return `<form class="form-stack" action="${renameAction}" method="post" hx-post="${renameAction}" ${htmxDialogForm} hx-indicator="#activity-indicator"><h2>Rename column</h2><label>Name<input name="name" required maxlength="64" value="${escapeHtml(column.name)}" autofocus></label><div class="dialog-actions"><button type="button" command="close" commandfor="modal">Cancel</button><button class="primary bevel" type="submit">Save name</button></div></form><form class="form-stack" action="${archiveAction}" method="post" hx-post="${archiveAction}" ${htmxDialogForm} hx-indicator="#activity-indicator" hx-confirm="Archive ‘${escapeHtml(column.name)}’? The column must be empty before it can be archived."><h2>Archive column</h2><p class="form-note">The column must be empty before it can be archived.</p><div class="dialog-actions"><button type="button" command="close" commandfor="modal">Cancel</button><button class="danger" type="submit">Archive column</button></div></form>`;
}

export function renderTaskForm(projectId: string, columnId: string): string {
  const project = projectById(projectId);
  const columns = listColumns(projectId);
  const selected =
    columns.find((column) => column.id === columnId) ?? columns[0];
  if (!selected)
    throw new Error("no column is available — create one in Columns first");
  const options = columns
    .map(
      (column) =>
        `<option value="${column.id}"${column.id === selected.id ? " selected" : ""}>${escapeHtml(column.name)}</option>`,
    )
    .join("");
  return `<form class="form-stack" action="/projects/${project.id}/tasks" method="post" hx-post="/projects/${project.id}/tasks" ${htmxDialogForm} hx-indicator="#activity-indicator"><h2>New card</h2><label>Title<input name="title" required maxlength="256" autofocus autocomplete="off"></label><label>Column<select name="column" required>${options}</select></label><label>Brief description<textarea name="description" maxlength="1024" rows="5"></textarea></label><div class="dialog-actions"><button type="button" command="close" commandfor="modal">Cancel</button><button class="primary bevel" type="submit">Create card</button></div><p class="form-note">Creating in ${escapeHtml(project.name)}.</p></form>`;
}
