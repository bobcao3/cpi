import { listTopics } from "../core/topics";
import { shortId } from "../core/id";
import { collectProjectAudit, relativeTime } from "./format";
import { enc, escapeHtml, htmxForm, type Notice } from "./html";
import { projectById, workspace } from "./layout";

export function renderTopics(projectId: string, notice?: Notice): string {
  const project = projectById(projectId);
  const topicRows = listTopics(projectId, 201);
  const topics = topicRows.slice(0, 200);
  const hasMoreTopics = topicRows.length > 200;
  const ids = topics.map((topic) => topic.id);
  const rows = topics
    .map((topic) => {
      const base = `/projects/${enc(projectId)}/topics/${enc(topic.id)}`;
      return `<li class="record-row bevel"><code>${shortId(topic.id, ids)}</code><form class="inline-editor" action="${base}/rename" method="post" hx-post="${base}/rename" ${htmxForm}><label><span class="sr-only">Topic name</span><input name="name" value="${escapeHtml(topic.name)}" required maxlength="128"></label><button type="submit">Rename</button></form><form action="${base}/archive" method="post" hx-post="${base}/archive" ${htmxForm} hx-confirm="Archive ‘${escapeHtml(topic.name)}’? Existing cards will no longer show this topic."><button class="danger" type="submit">Archive</button></form></li>`;
    })
    .join("");
  const body = `<section class="admin-grid"><section class="window"><div class="bar"><h2>Topic catalog</h2><span>${topics.length}</span></div><div class="window-body">${rows ? `<ul class="record-list">${rows}</ul>` : '<div class="empty-state"><strong>No topics.</strong><span>Create the first reusable label.</span></div>'}${hasMoreTopics ? '<p class="form-note">This view is limited to 200 topics; clidos can access the remaining records.</p>' : ""}</div></section><aside class="window create-panel"><div class="bar"><h2>New topic</h2><span>＋</span></div><form class="window-body form-stack" action="/projects/${project.id}/topics" method="post" hx-post="/projects/${project.id}/topics" ${htmxForm}><label>Name<input name="name" required maxlength="128" autocomplete="off" placeholder="Research"></label><button class="primary bevel" type="submit">Create topic</button><p class="form-note">Topics remain project-scoped and can label many cards.</p></form></aside></section>`;
  return workspace(body, {
    title: `${project.name} topics`,
    path: `/projects/${enc(projectId)}/topics`,
    project,
    active: "topics",
    notice,
    poll: true,
  });
}

export function renderActivity(projectId: string): string {
  const project = projectById(projectId);
  const rows = collectProjectAudit(projectId, 200);
  const events = rows
    .map(
      (row) =>
        `<li class="event-row"><time datetime="${new Date(row.ts).toISOString()}">${relativeTime(row.ts)}</time><code>${escapeHtml(row.action)}</code><span>${escapeHtml(row.summary)}</span></li>`,
    )
    .join("");
  const body = `<section class="window activity-window"><div class="bar"><h2>Activity log</h2><span>${rows.length}</span></div><div class="window-body">${events ? `<ol class="event-list">${events}</ol>` : '<div class="empty-state"><strong>No activity yet.</strong><span>Changes will appear here.</span></div>'}</div></section>`;
  return workspace(body, {
    title: `${project.name} activity`,
    path: `/projects/${enc(projectId)}/activity`,
    project,
    active: "activity",
    poll: true,
  });
}
