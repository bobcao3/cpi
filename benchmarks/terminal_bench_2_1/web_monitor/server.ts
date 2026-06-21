// WebSocket monitor for TerminalBench 2.1 harbor jobs.
// Server pushes live deltas over /ws?job=<job>: result (2s), trials (2s),
// and streaming transcript increments from agent/pi.txt (1s) for the
// client's selected trial. Deterministic internal polling (not fs.watch)
// so docker bind-mount writes are reliable.
//
//   bun run server.ts [--jobs <dir>] [--port 8787]

import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
function flag(name: string, dflt: string): string {
  const i = a.indexOf(`--${name}`);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}
const JOBS_DIR = resolve(flag("jobs", join(HERE, "..", "jobs")));
const PORT = Number(flag("port", "8787"));
const CAP = 4000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function safeSeg(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\0") || s === "." || s === "..") return null;
  return s;
}
async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

function fmtError(ei: any): string {
  if (typeof ei === "string") return ei.slice(0, 500);
  const t = ei?.exception_type ? String(ei.exception_type) : "";
  const m = ei?.exception_message ? String(ei.exception_message) : "";
  const s = t ? (m ? t + ": " + m : t) : (m || JSON.stringify(ei));
  return s.slice(0, 500);
}

function summarize(r: any, trial: string) {
  const task = (r?.task_name || trial).replace(/^terminal-bench\//, "");
  let status = "running";
  if (!r) status = "running";
  else if (r.verifier_result?.rewards?.reward != null) status = "completed";
  else if (r.exception_info) status = "errored";
  else if (r.finished_at) status = "completed";
  const ar = r?.agent_result || {};
  const durMs = r?.started_at && r?.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null;
  return {
    trial, task, status,
    reward: r?.verifier_result?.rewards?.reward ?? null,
    in_tokens: ar.n_input_tokens ?? null,
    out_tokens: ar.n_output_tokens ?? null,
    cost_usd: ar.cost_usd ?? null,
    duration_s: durMs == null ? null : Math.round(durMs / 1000),
    error: r?.exception_info ? fmtError(r.exception_info) : null,
    finished: r?.finished_at ?? null,
    failover: false,
  };
}

async function listJobs() {
  let entries: string[] = [];
  try { entries = await readdir(JOBS_DIR); } catch { return []; }
  const out: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    try { const st = await stat(join(JOBS_DIR, name)); if (st.isDirectory()) out.push({ name, mtime: st.mtimeMs }); } catch {}
  }
  out.sort((x, y) => y.mtime - x.mtime);
  return out;
}

const failoverCache = new Map<string, boolean>();

async function trialFailover(job: string, trial: string, finished: boolean): Promise<boolean> {
  const key = job + "/" + trial;
  if (finished && failoverCache.has(key)) return failoverCache.get(key)!;
  let failover = false;
  try {
    const path = join(JOBS_DIR, job, trial, "agent", "pi.txt");
    const size = Bun.file(path).size;
    if (size > 0) {
      const off = Math.max(0, size - 32768);
      const text = Buffer.from(await Bun.file(path).slice(off, size).arrayBuffer()).toString("utf8");
      failover = text.includes("provider-failover") || text.includes("no fallback candidate");
    }
  } catch {}
  if (finished) failoverCache.set(key, failover);
  return failover;
}

async function listTrials(job: string) {
  let entries: string[] = [];
  try { entries = await readdir(join(JOBS_DIR, job)); } catch { return []; }
  const trials: any[] = [];
  for (const name of entries) {
    if (!name.includes("__")) continue;
    try { (await stat(join(JOBS_DIR, job, name))).isDirectory(); } catch { continue; }
    const r = await readJson(join(JOBS_DIR, job, name, "result.json"));
    const s = summarize(r, name);
    s.failover = await trialFailover(job, name, !!r?.finished_at);
    trials.push(s);
  }
  trials.sort((x, y) => x.task.localeCompare(y.task));
  return trials;
}

// Read JSONL lines from `after` index. Re-reads whole file (cheap for monitor).
async function readLines(rel: string, after: number) {
  let raw = "";
  try { raw = await readFile(join(JOBS_DIR, rel), "utf8"); } catch {
    return { events: [], next: after, total: 0, missing: true };
  }
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = Math.min(after, total);
  const slice = lines.slice(start, start + CAP);
  const events: any[] = [];
  for (const ln of slice) {
    if (!ln) continue;
    try { events.push(JSON.parse(ln)); } catch { events.push({ type: "raw", text: ln }); }
  }
  return { events, next: start + slice.length, total };
}

async function readVerifier(job: string, trial: string) {
  const td = join(JOBS_DIR, job, trial);
  const rd = async (rel: string) => { try { return await readFile(join(td, rel), "utf8"); } catch { return null; } };
  return { reward: (await rd("verifier/reward.txt"))?.trim() ?? null, stdout: await rd("verifier/test-stdout.txt") };
}

// ---- REST (initial html + verifier + log tail) ----
async function handle(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const p = u.pathname.split("/").filter(Boolean);
  const json = (o: any) => new Response(JSON.stringify(o), { headers: { "content-type": MIME[".json"], "cache-control": "no-store" } });
  if (p.length === 0 || p[0] === "index.html") {
    return new Response(await readFile(join(HERE, "index.html"), "utf8"), { headers: { "content-type": MIME[".html"], "cache-control": "no-store" } });
  }
  if (p[0] !== "api") return new Response("not found", { status: 404 });
  if (p[1] === "jobs") return json(await listJobs());
  if (p[1] === "job" && p[3] === "result") { const j = safeSeg(p[2]); return j ? json(await readJson(join(JOBS_DIR, j, "result.json")) ?? { error: "none" }) : new Response("bad", { status: 400 }); }
  if (p[1] === "job" && p[3] === "trials") { const j = safeSeg(p[2]); return j ? json(await listTrials(j)) : new Response("bad", { status: 400 }); }
  if (p[1] === "job" && p[3] === "log") { const j = safeSeg(p[2]); const n = Number(u.searchParams.get("after") ?? 0); return j ? json(await readLines(join(j, "job.log"), n)) : new Response("bad", { status: 400 }); }
  if (p[1] === "job" && p[3] === "trial" && p[5] === "verifier") { const j = safeSeg(p[2]), t = safeSeg(p[4]); return j && t ? json(await readVerifier(j, t)) : new Response("bad", { status: 400 }); }
  return new Response("not found", { status: 404 });
}

// ---- WS connection state ----
type Conn = { job: string; trial: string; tOff: number; rSig: string; tSig: string; trialW: FSWatcher | null; statW: FSWatcher | null; tDb: any; sDb: any };
const conns = new Map<any, Conn>();

function send(ws: any, type: string, data: any) { try { ws.send(JSON.stringify({ type, ...data })); } catch {} }

// Coalesce rapid fs.watch event bursts into a single deferred call.
function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(); }, ms);
  };
}

async function pushStats(ws: any, c: Conn) {
  const r = await readJson(join(JOBS_DIR, c.job, "result.json"));
  const sig = JSON.stringify(r?.stats ?? null);
  if (sig !== c.rSig) { c.rSig = sig; send(ws, "result", { result: r }); }
  const trials = await listTrials(c.job);
  const tsig = JSON.stringify(trials);
  if (tsig !== c.tSig) { c.tSig = tsig; send(ws, "trials", { trials }); }
}

async function streamNew(c: Conn): Promise<any[] | null> {
  if (!c.trial) return null;
  const path = join(JOBS_DIR, c.job, c.trial, "agent", "pi.txt");
  let size: number;
  try { size = Bun.file(path).size; } catch { return null; }
  if (size < c.tOff) c.tOff = 0;
  if (size === c.tOff) return null;
  const buf = Buffer.from(await Bun.file(path).slice(c.tOff, size).arrayBuffer());
  const lastNL = buf.lastIndexOf(0x0a);
  if (lastNL < 0) return null;
  const chunk = buf.subarray(0, lastNL + 1);
  c.tOff += lastNL + 1;
  const text = chunk.toString("utf8");
  const lines = text.split("\n");
  const events: any[] = [];
  for (const ln of lines) {
    if (!ln) continue;
    try { events.push(JSON.parse(ln)); } catch { events.push({ type: "raw", text: ln }); }
  }
  return events.length ? events : null;
}

async function pushTranscript(ws: any, c: Conn) {
  const events = await streamNew(c);
  if (events) { send(ws, "transcript", { events, next: c.tOff }); }
}

function closeTrialWatcher(c: Conn) {
  if (c.trialW) { try { c.trialW.close(); } catch {} c.trialW = null; }
  c.tDb = null;
}

function closeStatWatcher(c: Conn) {
  if (c.statW) { try { c.statW.close(); } catch {} c.statW = null; }
  c.sDb = null;
}

function openStatWatcher(ws: any, c: Conn) {
  closeStatWatcher(c);
  try {
    c.statW = watch(join(JOBS_DIR, c.job), debounce(() => pushStats(ws, c), 150));
  } catch {
    c.statW = null;
  }
}

function openTrialWatcher(ws: any, c: Conn) {
  closeTrialWatcher(c);
  if (!c.trial) return;
  const p = join(JOBS_DIR, c.job, c.trial, "agent", "pi.txt");
  try {
    c.trialW = watch(p, debounce(() => pushTranscript(ws, c), 30));
  } catch {
    c.trialW = null;
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  websocket: {
    open(ws: any) {
      const job = ws.data?.job;
      if (!job) { ws.close(1008, "no job"); return; }
      const c: Conn = { job, trial: "", tOff: 0, rSig: "", tSig: "", trialW: null, statW: null, tDb: null, sDb: null };
      conns.set(ws, c);
      openStatWatcher(ws, c);
      pushStats(ws, c);
    },
    message(ws: any, msg: any) {
      const c = conns.get(ws); if (!c) return;
      try {
        const m = JSON.parse(msg.toString());
        if (m.type === "select") {
          c.trial = safeSeg(m.trial) || "";
          c.tOff = 0;
          send(ws, "select", { trial: c.trial }); // client clears view
          closeTrialWatcher(c);
          pushTranscript(ws, c); // backfill from byte 0
          openTrialWatcher(ws, c);
        }
      } catch {}
    },
    close(ws: any) {
      const c = conns.get(ws);
      if (c) { closeTrialWatcher(c); closeStatWatcher(c); }
      conns.delete(ws);
    },
  },
  fetch(req: Request, s: any) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      const job = safeSeg(u.searchParams.get("job"));
      if (!job) return new Response("bad job", { status: 400 });
      return s.upgrade(req, { data: { job } });
    }
    return handle(req);
  },
});

// fs.watch drives real-time streaming; the 1s intervals below are a safety
// backstop only, catching any missed filesystem events.
setInterval(() => { for (const [ws, c] of conns) { pushTranscript(ws, c); } }, 1000);
setInterval(() => { for (const [ws, c] of conns) pushStats(ws, c); }, 1000);

console.log(`TB2.1 WS monitor → ws://0.0.0.0:${PORT}/ws?job=<job>  (jobs: ${JOBS_DIR})`);
