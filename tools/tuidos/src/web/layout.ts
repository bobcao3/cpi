import { getProject, type ProjectRow } from "../core/db";
import { enc, escapeHtml, renderNotice, type Notice } from "./html";

export function projectById(projectId: string): ProjectRow {
  const project = getProject(projectId);
  if (!project)
    throw new Error(
      "project is unavailable — return to Projects and choose another",
    );
  return project;
}

function projectNavigation(
  project: ProjectRow,
  active: "board" | "topics" | "columns" | "activity",
): string {
  const base = `/projects/${enc(project.id)}`;
  const item = (name: string, href: string, key: typeof active) =>
    `<a class="tab${active === key ? " is-active" : ""}" href="${href}" hx-get="${href}" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true">${name}</a>`;
  return `<nav class="top-nav" aria-label="Project sections">${item("Board", base, "board")}${item("Topics", `${base}/topics`, "topics")}${item("Columns", `${base}/columns`, "columns")}${item("Activity", `${base}/activity`, "activity")}</nav>`;
}

function menuBar(
  project?: ProjectRow,
  active?: "board" | "topics" | "columns" | "activity",
): string {
  const firstRow = project
    ? `<a class="back-button" href="/" hx-get="/" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true" aria-label="All projects">&lt;</a><strong class="project-identity">Project: ${escapeHtml(project.name)}</strong>`
    : `<a class="brand" href="/" hx-get="/" hx-target="#workspace" hx-swap="outerHTML" hx-push-url="true"><span class="brand-mark" aria-hidden="true">◆</span> tuidos</a><span class="menubar-copy">Personal workbench</span>`;
  return `<header class="menubar"><div class="menu-line">${firstRow}<span id="activity-indicator" class="htmx-indicator" role="status">Working…</span></div>${project ? projectNavigation(project, active ?? "board") : ""}</header>`;
}

function scrollRegion(content: string): string {
  return `<div class="scroll-region"><main class="workspace-body" tabindex="0">${content}</main><div class="os8-scrollbar os8-vertical"><button type="button" tabindex="-1" aria-hidden="true" class="os8-up" data-axis="vertical" data-direction="up">▲</button><div class="os8-track"><div class="os8-thumb"></div></div><button type="button" tabindex="-1" aria-hidden="true" class="os8-down" data-axis="vertical" data-direction="down">▼</button></div><div class="os8-scrollbar os8-horizontal"><button type="button" tabindex="-1" aria-hidden="true" class="os8-left" data-axis="horizontal" data-direction="left">◀</button><div class="os8-track"><div class="os8-thumb"></div></div><button type="button" tabindex="-1" aria-hidden="true" class="os8-right" data-axis="horizontal" data-direction="right">▶</button></div><div class="os8-corner"></div></div>`;
}

export function workspace(
  body: string,
  options: {
    title: string;
    path: string;
    project?: ProjectRow;
    active?: "board" | "topics" | "columns" | "activity";
    notice?: Notice;
    poll?: boolean;
    footer?: string;
  },
): string {
  const poll = options.poll
    ? ` hx-get="${options.path}" hx-sync="#workspace:drop" hx-sync:inherited="#workspace:replace" hx-trigger="every 5s" hx-swap="outerMorph"`
    : "";
  const head = options.project
    ? ""
    : `<header class="project-head window-title"><div><span class="eyebrow">Local task system</span><h1>${escapeHtml(options.title)}</h1></div></header>`;
  return `<div id="workspace"${options.footer ? ' class="workspace-with-footer"' : ""} hx-history-elt${poll}>${menuBar(options.project, options.active)}${scrollRegion(`${head}${renderNotice(options.notice)}${body}`)}${options.footer ?? ""}</div>`;
}

export function documentPage(content: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#9189cc"><meta name="htmx-config" content='{"defaultSwap":"innerHTML","history":true,"defaultFocusScroll":false,"allowEmptySwapAfterOOB":true}'><title>${escapeHtml(title)} · tuidos</title><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/board.css"><link rel="stylesheet" href="/assets/chrome.css"><script defer src="/assets/htmx-4.0.0.min.js"></script><script defer src="/assets/site.js"></script></head><body><div class="desktop">${content}</div><dialog id="modal" closedby="any" aria-labelledby='dialog-heading'><div class="dialog-title"><strong id="dialog-heading">Command panel</strong><button type="button" command="close" commandfor="modal" aria-label="Close">×</button></div><div id="modal-body" class="dialog-body">Loading…</div></dialog></body></html>`;
}

export function pageResponse(
  request: Request,
  content: string,
  title: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const fragment = request.headers.get("HX-Request") === "true";
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(
    fragment
      ? `<title>${escapeHtml(title)} · tuidos</title>${content}`
      : documentPage(content, title),
    {
      status: init.status,
      headers,
    },
  );
}
