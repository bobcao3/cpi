import { test, expect, afterEach, beforeEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProject } from "../core/db";
import { createTask, setTaskCompleted, listTasks } from "../core/tasks";
import { listColumns } from "../core/columns";
import { App } from "./app";
import { collectProjectAudit } from "./audit";
import * as S from "./store";

// Headless integration: render the real <App/> against a seeded temp state DB
// and drive it through the renderer's mock input. `flush()` after mount
// settles onMount (which registers the keyboard handler); `renderOnce()`
// after each action runs the render loop, which both processes the emitted
// keypress and paints the result. (flush() alone no-ops when the scheduler is
// already idle and does not drain stdin, so it cannot drive a keypress.)
//
// The bunfig `[test] preload` loads @opentui/solid/preload so the Solid
// transform plugin remaps solid-js/dist/server.js to the client build —
// otherwise the SSR build loads under bun test and onMount/effects never run.

let setup: Awaited<ReturnType<typeof testRender>>;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "tuidos-test-"));
  process.env.TUIDOS_STATE_DIR = stateDir;
  process.env.TUIDOS_LIVE_INTERVAL_MS = "40";
  S.setView("projects");
  S.setProjectId(null);
  S.setCardId(null);
  S.setSelProject(0);
  S.setSelCol(0);
  S.setSelTask(0);
  S.setSelTopic(0);
  S.cancelPrompt();
  S.setHelpOpen(false);
  S.setToast(null);
});

afterEach(() => {
  if (setup) setup.renderer.destroy();
  delete process.env.TUIDOS_STATE_DIR;
  delete process.env.TUIDOS_LIVE_INTERVAL_MS;
});

test("renders the project list and the board", async () => {
  const p = createProject("Demo", "a demo project");
  const t = createTask(p.id, { title: "Ship the board" });
  setTaskCompleted(p.id, t.id, true);

  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Demo");

  setup.mockInput.pressEnter(); // open the project -> board
  await setup.renderOnce();
  const board = setup.captureCharFrame();
  expect(board).toContain("Backlog");
  expect(board).toContain("In Progress");
  expect(board).toContain("Done");
  expect(board).toContain("Ship the board");
  // Header shows the active card count: "Demo — board (1)" (1 task total).
  expect(board).toContain("(1)");
});

test("a store write re-renders the board", async () => {
  const p = createProject("Solo", null);
  S.openProject(p.id);
  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Solo");

  S.newCard("Freshly created");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Freshly created");
  expect(listColumns(p.id)[0]?.name).toBe("Backlog");
});

test("n opens the new-card prompt, esc closes it", async () => {
  const p = createProject("Prompt", null);
  S.openProject(p.id);
  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();
  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("New card");
  setup.mockInput.pressEscape();
  await new Promise((r) => setTimeout(r, 60));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("New card");
});

test("live refresh surfaces an external write that bypasses the store", async () => {
  const p = createProject("Live", null);
  S.openProject(p.id);
  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();
  // Let the data_version poller establish the project baseline (3 intervals).
  await new Promise((r) => setTimeout(r, 120));
  expect(setup.captureCharFrame()).not.toContain("External card");

  // This write bypasses the store entirely — createTask mutates the DB
  // directly without bumping the store's rev, so only the poller can
  // surface the change.
  createTask(p.id, { title: "External card" });
  await new Promise((r) => setTimeout(r, 150));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("External card");
});

test("audit view header shows the row count", async () => {
  const p = createProject("Audit", null);
  const t = createTask(p.id, { title: "Ship the board" });
  setTaskCompleted(p.id, t.id, true);
  S.openProject(p.id);
  S.goto("audit");

  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();
  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  // `count` is derived from the same collectProjectAudit the audit view uses,
  // so this assertion ties the rendered header to the real row count.
  const count = collectProjectAudit(p.id, 200).length;
  expect(count).toBeGreaterThan(0);
  expect(frame).toContain(`Activity (${count})`);
});

test("x archives and u restores the card (round-trip)", async () => {
  const p = createProject("Undo", null);
  const t = createTask(p.id, { title: "Stray press" });
  S.openProject(p.id);
  setup = await testRender(() => <App />, { width: 80, height: 24 });
  await setup.flush();

  // x: the card leaves the active list; the toast hints the restore key.
  S.archiveCurrentCard();
  await setup.renderOnce();
  expect(listTasks(p.id).find((x) => x.id === t.id)).toBeUndefined();
  expect(setup.captureCharFrame()).toContain("u to restore");

  // u: the card returns; the audit records both halves of the round-trip.
  S.unarchiveLastArchive();
  await setup.renderOnce();
  expect(listTasks(p.id).find((x) => x.id === t.id)).toBeDefined();
  const audit = collectProjectAudit(p.id, 200);
  expect(audit.some((r) => r.action === "task.archive")).toBe(true);
  expect(audit.some((r) => r.action === "task.unarchive")).toBe(true);
});
