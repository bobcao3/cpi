import { createSignal } from "solid-js";
import { listProjects, createProject, type ProjectRow } from "../core/db";
import { listColumns } from "../core/columns";
import {
  listTasks, getTask, createTask, updateTask, moveTask, setTaskCompleted, archiveTask, unarchiveTask,
  type TaskRow,
} from "../core/tasks";
import {
  listTopics, createTopic, renameTopic, archiveTopic, attachTopic, detachTopic, listTopicsForTask,
} from "../core/topics";
import { createMessage } from "../core/messages";
import { resolveIdentity, authorString, fallbackWarning } from "../core/identity";

// The controller: a singleton reactive store. Signals live at module scope
// (createSignal is fine outside a reactive root; only memos/effects need one),
// and views read them inside JSX/computations which run under render's root.
// Writes call the shared core/* (the Model — same functions clidos uses) then
// bump a `rev` signal; views wrap their reads in rev-keyed memos, so a write
// re-fetches exactly the affected data. Errors from core throw a helpful
// remedy; we catch and surface it as a toast rather than crashing the TUI.

export type View = "projects" | "board" | "card" | "topics" | "audit";

// --- reactive state ---
export const [view, setView] = createSignal<View>("projects");
export const [projectId, setProjectId] = createSignal<string | null>(null);
export const [cardId, setCardId] = createSignal<string | null>(null);
export const [selProject, setSelProject] = createSignal(0);
export const [selCol, setSelCol] = createSignal(0);
export const [selTask, setSelTask] = createSignal(0);
export const [selTopic, setSelTopic] = createSignal(0);
export const [rev, setRev] = createSignal(0); // bump after writes -> memos refetch
export const [toast, setToast] = createSignal<{ kind: "ok" | "error" | "warn"; msg: string } | null>(null);
export const [prompt, setPrompt] = createSignal<{ title: string; onSubmit: (v: string) => void } | null>(null);
export const [promptValue, setPromptValue] = createSignal("");
export const [helpOpen, setHelpOpen] = createSignal(false);

let destroyApp: () => void = () => {};
export function setDestroyApp(fn: () => void): void { destroyApp = fn; }

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flash(kind: "ok" | "error" | "warn", msg: string): void {
  if (toastTimer) clearTimeout(toastTimer);
  setToast({ kind, msg });
  toastTimer = setTimeout(() => setToast(null), 2800);
}
function bump(): void { setRev((r) => r + 1); }
/** Run a core write; on success bump + flash ok, on throw flash the remedy. */
function write(label: string, fn: () => void): void {
  try { fn(); bump(); flash("ok", label); }
  catch (e) { flash("error", errMsg(e)); }
}

// --- navigation (no writes; reads are fresh on view remount) ---
export function openProject(id: string): void { setProjectId(id); setSelCol(0); setSelTask(0); setView("board"); }
export function backToProjects(): void { setProjectId(null); setCardId(null); setView("projects"); }
export function openCard(id: string): void { setCardId(id); setView("card"); }
export function closeCard(): void { setCardId(null); setView("board"); }
export function goto(v: View): void { setView(v); }
export function toggleHelp(): void { setHelpOpen((h) => !h); }
export function quit(): void { destroyApp(); }
export function escape(): void {
  switch (view()) {
    case "card": closeCard(); break;
    case "topics": setView(cardId() ? "card" : "board"); break;
    case "audit": setView("board"); break;
    case "board": backToProjects(); break;
    case "projects": quit(); break;
  }
}

// --- prompt modal ---
export function openPrompt(title: string, initial: string, onSubmit: (v: string) => void): void {
  setPromptValue(initial);
  setPrompt({ title, onSubmit });
}
export function cancelPrompt(): void { setPrompt(null); }
export function submitPrompt(): void {
  const p = prompt();
  const v = promptValue().trim();
  setPrompt(null);
  if (p && v) p.onSubmit(v);
}

// --- project list ---
export function navProjectDown(): void { setSelProject((s) => clamp(s + 1, 0, Math.max(0, listProjects().length - 1))); }
export function navProjectUp(): void { setSelProject((s) => clamp(s - 1, 0, Math.max(0, listProjects().length - 1))); }
export function openSelectedProject(): void {
  const ps = listProjects();
  if (ps.length === 0) { openPrompt("New project", "", newProject); return; }
  openProject(ps[clamp(selProject(), 0, ps.length - 1)]!.id);
}
export function newProject(name: string): void {
  try { const p: ProjectRow = createProject(name, null); bump(); flash("ok", `Created project ${name}`); openProject(p.id); }
  catch (e) { flash("error", errMsg(e)); }
}

// --- board: the current task under selection (cols×tasks grid) ---
function curTask(): { p: string; task: TaskRow } | null {
  const pid = projectId(); if (!pid) return null;
  const cols = listColumns(pid);
  const col = cols[clamp(selCol(), 0, cols.length - 1)];
  if (!col) return null;
  const tasks = listTasks(pid, col.id);
  const task = tasks[clamp(selTask(), 0, Math.max(0, tasks.length - 1))];
  return task ? { p: pid, task } : null;
}

export function navDown(): void {
  const pid = projectId(); if (!pid) return;
  const cols = listColumns(pid); if (cols.length === 0) return;
  const ci = clamp(selCol(), 0, cols.length - 1);
  const tasks = listTasks(pid, cols[ci]!.id);
  if (selTask() + 1 < tasks.length) { setSelTask(selTask() + 1); return; }
  setSelCol((ci + 1) % cols.length); setSelTask(0);
}
export function navUp(): void {
  const pid = projectId(); if (!pid) return;
  const cols = listColumns(pid); if (cols.length === 0) return;
  const ci = clamp(selCol(), 0, cols.length - 1);
  if (selTask() > 0) { setSelTask(selTask() - 1); return; }
  const prev = (ci - 1 + cols.length) % cols.length;
  const tasks = listTasks(pid, cols[prev]!.id);
  setSelCol(prev); setSelTask(Math.max(0, tasks.length - 1));
}
export function navLeft(): void {
  const pid = projectId(); if (!pid) return;
  const cols = listColumns(pid); if (cols.length === 0) return;
  setSelCol((c) => (c - 1 + cols.length) % cols.length); setSelTask(0);
}
export function navRight(): void {
  const pid = projectId(); if (!pid) return;
  const cols = listColumns(pid); if (cols.length === 0) return;
  setSelCol((c) => (c + 1) % cols.length); setSelTask(0);
}

export function openCurrentCard(): void { const c = curTask(); if (c) openCard(c.task.id); }

export function newCard(title: string): void {
  const pid = projectId(); if (!pid) return;
  const cols = listColumns(pid);
  const col = cols[clamp(selCol(), 0, cols.length - 1)];
  if (!col) { flash("error", "no column — add one first (clidos -p <project> columns create)"); return; }
  write(`Created card`, () => createTask(pid, { title, column_id: col.id }));
  setSelTask(Math.max(0, listTasks(pid, col.id).length - 1));
}

function moveCardSel(dir: -1 | 1): void {
  const c = curTask(); if (!c) return;
  const cols = listColumns(c.p);
  const ci = clamp(selCol(), 0, cols.length - 1);
  const dst = ci + dir;
  if (dst < 0 || dst >= cols.length) { flash("error", dir < 0 ? "already at the first column" : "already at the last column"); return; }
  const target = cols[dst]!;
  write(`Moved to ${target.name}`, () => moveTask(c.p, c.task.id, target.id));
  setSelCol(dst); setSelTask(Math.max(0, listTasks(c.p, target.id).length - 1));
}
export function moveCardLeft(): void { moveCardSel(-1); }
export function moveCardRight(): void { moveCardSel(1); }

export function toggleDone(): void {
  const c = curTask(); if (!c) return;
  const done = c.task.completed_at != null;
  write(done ? "Reopened" : "Completed", () => setTaskCompleted(c.p, c.task.id, !done));
}

// The last card archived this session — `u` restores it (reversible x). Like
// identityWarned, plain module state (not a signal): client-only memory of a
// past write, scoped to this process and to its project.
let lastArchive: { id: string; title: string; projectId: string } | null = null;
export function archiveCurrentCard(): void {
  const c = curTask(); if (!c) return;
  const col = listColumns(c.p)[clamp(selCol(), 0, listColumns(c.p).length - 1)]!;
  try {
    archiveTask(c.p, c.task.id);
    lastArchive = { id: c.task.id, title: c.task.title, projectId: c.p };
    bump();
    flash("ok", `Archived ${c.task.title} — u to restore`);
  } catch (e) {
    flash("error", errMsg(e));
  }
  setSelTask(clamp(selTask(), 0, Math.max(0, listTasks(c.p, col?.id ?? "").length - 1)));
}
export function unarchiveLastArchive(): void {
  const a = lastArchive;
  if (!a) { flash("warn", "nothing to restore"); return; }
  if (a.projectId !== projectId()) { flash("warn", "nothing to restore in this project"); return; }
  try {
    const { title, column, relocated } = unarchiveTask(a.projectId, a.id);
    lastArchive = null;
    bump();
    flash("ok", relocated ? `Restored ${title} — moved to ${column}` : `Restored ${title}`);
  } catch (e) {
    flash("error", errMsg(e));
  }
}

export function editCardTitle(): void {
  const c = curTask(); if (!c) return;
  openPrompt("Edit card title", c.task.title, (v) => {
    const pid = projectId(); if (pid) write("Updated", () => updateTask(pid, c.task.id, { title: v }));
  });
}

// --- card detail ---
let identityWarned = false;
export function addMessage(content: string): void {
  const pid = projectId(); const cid = cardId();
  if (!pid || !cid) return;
  const id = resolveIdentity();
  try {
    createMessage(pid, cid, authorString(id), content);
    bump();
    if (id.source === "fallback" && !identityWarned) {
      identityWarned = true;
      flash("warn", fallbackWarning(id));
    } else {
      flash("ok", "Added message");
    }
  } catch (e) {
    flash("error", errMsg(e));
  }
}
export function toggleDoneCard(): void {
  const pid = projectId(); const cid = cardId(); if (!pid || !cid) return;
  const t = getTask(pid, cid); if (!t) return;
  const done = t.completed_at != null;
  write(done ? "Reopened" : "Completed", () => setTaskCompleted(pid, cid, !done));
}
export function archiveCardFromDetail(): void {
  const pid = projectId(); const cid = cardId(); if (!pid || !cid) return;
  try {
    const title = archiveTask(pid, cid);
    lastArchive = { id: cid, title, projectId: pid };
    bump();
    flash("ok", `Archived ${title} — u to restore`);
  } catch (e) {
    flash("error", errMsg(e));
  }
  closeCard();
}
export function toggleTopicOnCard(topicId: string): void {
  const pid = projectId(); const cid = cardId(); if (!pid || !cid) return;
  const on = listTopicsForTask(pid, cid).some((t) => t.id === topicId);
  write(on ? "Untagged" : "Tagged", () => (on ? detachTopic(pid, cid, topicId) : attachTopic(pid, cid, topicId)));
}

export function toggleCurrentTopicOnCard(): void {
  const pid = projectId(); if (!pid) return;
  const ts = listTopics(pid); const t = ts[clamp(selTopic(), 0, Math.max(0, ts.length - 1))];
  if (!t) return;
  toggleTopicOnCard(t.id);
}

// --- topics view ---
export function navTopicDown(): void { const pid = projectId(); if (!pid) return; setSelTopic((s) => clamp(s + 1, 0, Math.max(0, listTopics(pid).length - 1))); }
export function navTopicUp(): void { const pid = projectId(); if (!pid) return; setSelTopic((s) => clamp(s - 1, 0, Math.max(0, listTopics(pid).length - 1))); }
export function newTopic(name: string): void {
  const pid = projectId(); if (!pid) return;
  write("Created topic", () => createTopic(pid, name));
}
export function renameCurrentTopic(): void {
  const pid = projectId(); if (!pid) return;
  const ts = listTopics(pid); const t = ts[clamp(selTopic(), 0, ts.length - 1)];
  if (!t) return;
  openPrompt("Rename topic", t.name, (v) => { if (pid) write("Renamed", () => renameTopic(pid, t.id, v)); });
}
export function archiveCurrentTopic(): void {
  const pid = projectId(); if (!pid) return;
  const ts = listTopics(pid); const t = ts[clamp(selTopic(), 0, ts.length - 1)];
  if (!t) return;
  write("Archived", () => archiveTopic(pid, t.id));
  setSelTopic((s) => clamp(s, 0, Math.max(0, ts.length - 2)));
}
