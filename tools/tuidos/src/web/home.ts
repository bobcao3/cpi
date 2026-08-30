import { listProjects } from "../core/db";
import { shortId } from "../core/id";
import { escapeHtml, htmxForm, type Notice } from "./html";
import { relativeTime } from "./format";
import { workspace } from "./layout";

export function renderHome(query = "", notice?: Notice): string {
  const normalized = query.trim().toLocaleLowerCase().slice(0, 128);
  const candidates = listProjects(201);
  const truncated = candidates.length > 200;
  const all = candidates.slice(0, 200);
  const projects = normalized
    ? all.filter((project) =>
        `${project.name}\n${project.description ?? ""}`
          .toLocaleLowerCase()
          .includes(normalized),
      )
    : all;
  const cards = projects
    .map(
      (project) =>
        `<article class="project-card bevel"><div class="project-glyph" aria-hidden="true">▦</div><div><h2><a href="/projects/${project.id}" hx-get="/projects/${project.id}" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true">${escapeHtml(project.name)}</a></h2><p>${escapeHtml(project.description ?? "No description yet.")}</p><div class="meta"><code>${shortId(
          project.id,
          all.map((item) => item.id),
        )}</code><span>${relativeTime(project.updated_at)}</span></div></div></article>`,
    )
    .join("");
  const empty = normalized
    ? `<div class="empty-state"><strong>No matching projects.</strong><span>Try a broader search.</span></div>`
    : `<div class="empty-state"><strong>Your desktop is clear.</strong><span>Create a project to begin.</span></div>`;
  const body = `<section class="home-grid"><section class="window"><div class="bar"><h2>Projects</h2><span>${projects.length}/${all.length}</span></div><div class="window-body"><label class="search-label" for="project-search">Find a project</label><input id="project-search" type="search" name="q" value="${escapeHtml(query)}" placeholder="Search names and descriptions" hx-get="/" hx-trigger="input changed delay:250ms" hx-target="#workspace" hx-swap="outerMorph" hx-push-url="true" hx-indicator="#activity-indicator"><div class="project-list">${cards || empty}</div>${truncated ? '<p class="form-note">Only the 200 most recently updated projects are shown; clidos can access the rest.</p>' : ""}</div></section><aside class="window create-panel"><div class="bar"><h2>New project</h2><span>⌘</span></div><form class="window-body form-stack" action="/projects" method="post" hx-post="/projects" ${htmxForm} hx-indicator="#activity-indicator"><label>Name<input name="name" required maxlength="128" autocomplete="off" placeholder="Ship room"></label><label>Description<textarea name="description" maxlength="512" rows="4" placeholder="What belongs here?"></textarea></label><button class="primary bevel" type="submit">Create project</button><p class="form-note">A useful starter board and topic set will be installed automatically.</p></form></aside></section>`;
  return workspace(body, {
    title: "Projects",
    path: normalized ? `/?q=${encodeURIComponent(query)}` : "/",
    notice,
  });
}
