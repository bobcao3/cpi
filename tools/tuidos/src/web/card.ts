import { listColumns } from "../core/columns";
import { listAllTaskIds, getTask, type TaskRow } from "../core/tasks";
import { listMessages } from "../core/messages";
import { listMediaForTask } from "../core/media";
import { listTopics, listTopicsForTask } from "../core/topics";
import { shortId } from "../core/id";
import { dueDate, humanSize, priorityLabel, relativeTime } from "./format";
import { enc, escapeHtml, htmxForm, type Notice } from "./html";
import { projectById, workspace } from "./layout";

function requireTask(projectId: string, taskId: string): TaskRow {
  const task = getTask(projectId, taskId);
  if (!task || task.archived_at != null)
    throw new Error(
      "card is unavailable — return to the board and choose another",
    );
  return task;
}

function topicPicker(
  projectId: string,
  taskId: string,
  topics: ReturnType<typeof listTopics>,
): string {
  const attached = new Set(
    listTopicsForTask(projectId, taskId).map((topic) => topic.id),
  );
  if (topics.length === 0)
    return '<p class="empty-copy">No topics yet. Create one from the Topics section.</p>';
  return `<div class="topic-picker">${topics
    .map((topic) => {
      const active = attached.has(topic.id);
      const url = `/projects/${enc(projectId)}/tasks/${enc(taskId)}/topics/${enc(topic.id)}`;
      return `<form action="${url}" method="post" hx-post="${url}" ${htmxForm}><input type="hidden" name="attached" value="${active ? "0" : "1"}"><button class="chip chip-button${active ? " is-selected" : ""}" type="submit" aria-pressed="${active}">${active ? "✓ " : "＋ "}${escapeHtml(topic.name)}</button></form>`;
    })
    .join("")}</div>`;
}

export function renderCard(
  projectId: string,
  taskId: string,
  notice?: Notice,
): string {
  const project = projectById(projectId);
  const task = requireTask(projectId, taskId);
  const taskIds = listAllTaskIds(projectId, 100_001);
  const taskLabel = shortId(task.id, taskIds);
  const columns = listColumns(projectId, 65).slice(0, 64);
  const column = columns.find((item) => item.id === task.column_id);
  const messageRows = listMessages(projectId, taskId, 501);
  const messages = messageRows.slice(0, 500);
  const mediaRows = listMediaForTask(projectId, taskId, 201);
  const media = mediaRows.slice(0, 200);
  const topicRows = listTopics(projectId, 201);
  const topics = topicRows.slice(0, 200);
  const limitNote =
    messageRows.length > 500 || mediaRows.length > 200 || topicRows.length > 200
      ? '<p class="form-note">Some records are omitted because the browser view has limits. clidos can access the remaining records.</p>'
      : "";
  const base = `/projects/${enc(projectId)}/tasks/${enc(taskId)}`;
  const priority = priorityLabel(task.priority);
  const due = dueDate(task.due_at);
  const thread = messages
    .map(
      (message, index) =>
        `<article class="message"><header><strong>${index === 0 ? "Body" : escapeHtml(message.author ?? "Anonymous")}</strong><time datetime="${new Date(message.created_at).toISOString()}">${relativeTime(message.created_at)}</time></header><p>${escapeHtml(message.content)}</p></article>`,
    )
    .join("");
  const files = media
    .map(
      (item) =>
        `<li><a href="${base}/media/${enc(item.id)}"><span aria-hidden="true">▣</span>${escapeHtml(item.filename)}</a><small>${humanSize(item.size_bytes)}</small></li>`,
    )
    .join("");
  const metadata = [
    column?.name ?? "Unknown column",
    priority,
    task.assignee ? `@${task.assignee}` : "",
    due ? `Due ${due}` : "",
    task.estimate == null
      ? ""
      : `${task.estimate} point${task.estimate === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/projects/${project.id}" hx-get="/projects/${project.id}" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true">Board</a><span>›</span><span>${taskLabel}</span></nav><section class="card-layout"><article class="window card-detail"><div class="bar"><h2>Card record</h2><span>${task.completed_at == null ? "OPEN" : "DONE"}</span></div><div class="window-body"><div class="detail-title"><div><span class="eyebrow">${taskLabel}</span><h2>${escapeHtml(task.title)}</h2></div><a class="bevel" href="${base}/edit" hx-get="${base}/edit" hx-target="#workspace" hx-swap="outerHTML">Edit</a></div><div class="detail-meta">${metadata}</div>${task.description ? `<p class="description">${escapeHtml(task.description)}</p>` : '<p class="empty-copy">No description.</p>'}<h3>Topics</h3>${topicPicker(projectId, taskId, topics)}${limitNote}<div class="detail-actions"><form action="${base}/completion" method="post" hx-post="${base}/completion" ${htmxForm}><input type="hidden" name="completed" value="${task.completed_at == null ? "1" : "0"}"><button class="primary bevel" type="submit">${task.completed_at == null ? "Mark complete" : "Reopen card"}</button></form><form action="${base}/archive" method="post" hx-post="${base}/archive" ${htmxForm} hx-confirm="Archive this card?"><button class="danger-button bevel" type="submit">Archive</button></form></div></div></article><aside class="window side-record"><div class="bar"><h2>Attachments</h2><span>${media.length}</span></div><div class="window-body">${files ? `<ul class="file-list">${files}</ul>` : '<p class="empty-copy">No attachments.</p>'}</div></aside></section><section class="window thread-window"><div class="bar"><h2>Conversation</h2><span>${messages.length}</span></div><div class="thread">${thread || '<p class="empty-copy">No messages yet. Start the conversation below.</p>'}</div><form class="message-form" action="${base}/messages" method="post" hx-post="${base}/messages" ${htmxForm} hx-indicator="#activity-indicator"><label for="message">Add a message</label><textarea id="message" name="content" required maxlength="16384" rows="3" placeholder="Write a useful update…"></textarea><button class="primary bevel" type="submit">Post message</button></form></section>`;
  return workspace(body, {
    title: task.title,
    path: base,
    project,
    active: "board",
    notice,
    poll: true,
  });
}

export function renderTaskEditor(
  projectId: string,
  taskId: string,
  notice?: Notice,
): string {
  const project = projectById(projectId);
  const task = requireTask(projectId, taskId);
  const base = `/projects/${enc(projectId)}/tasks/${enc(taskId)}`;
  const columns = listColumns(projectId)
    .map(
      (column) =>
        `<option value="${column.id}"${column.id === task.column_id ? " selected" : ""}>${escapeHtml(column.name)}</option>`,
    )
    .join("");
  const priorities = ["None", "Low", "Medium", "High", "Urgent"]
    .map(
      (label, value) =>
        `<option value="${value}"${value === (task.priority ?? 0) ? " selected" : ""}>${label}</option>`,
    )
    .join("");
  const body = `<nav class="crumbs"><a href="${base}" hx-get="${base}" hx-target="#workspace" hx-swap="outerHTML">Card</a><span>›</span><span>Edit</span></nav><section class="window editor-window"><div class="bar"><h2>Edit card</h2><span>${shortId(task.id, listAllTaskIds(projectId))}</span></div><form class="window-body form-stack" action="${base}/edit" method="post" hx-post="${base}/edit" ${htmxForm} hx-indicator="#activity-indicator"><label>Title<input name="title" value="${escapeHtml(task.title)}" required maxlength="256" autofocus></label><label>Description<textarea name="description" maxlength="1024" rows="6">${escapeHtml(task.description ?? "")}</textarea></label><div class="form-grid"><label>Column<select name="column" required>${columns}</select></label><label>Priority<select name="priority">${priorities}</select></label><label>Assignee<input name="assignee" value="${escapeHtml(task.assignee ?? "")}" maxlength="256"></label><label>Estimate<input name="estimate" type="number" min="0" max="1000000" value="${task.estimate ?? ""}"></label><label>Due date<input name="due" type="date" value="${dueDate(task.due_at)}"></label></div><div class="dialog-actions"><a class="bevel button-link" href="${base}" hx-get="${base}" hx-target="#workspace" hx-swap="outerHTML">Cancel</a><button class="primary bevel" type="submit">Save changes</button></div></form></section>`;
  return workspace(body, {
    title: `Edit ${task.title}`,
    path: `${base}/edit`,
    project,
    active: "board",
    notice,
  });
}
