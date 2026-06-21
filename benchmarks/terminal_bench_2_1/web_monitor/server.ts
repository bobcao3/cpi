// WebSocket monitor for TerminalBench 2.1 harbor jobs.
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
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function safeSeg(s: string | null | undefined): string | null {
  return !s || s.includes("/") || s.includes("\\") || s.includes("\0") || s === "." || s === ".." ? null : s;
}
// readJson: try/catch folded to promise chain.
const readJson = (p: string): Promise<any | null> => readFile(p, "utf8").then(s => JSON.parse(s)).catch(() => null);

const failoverCache = new Map<string, boolean>();

// listTrials folds summarize + fmtError + trialFailover inline (each sole-use).
async function listTrials(job: string) {
  const entries = await readdir(join(JOBS_DIR, job)).catch(() => [] as string[]);
  const trials: any[] = [];
  for (const name of entries) {
    if (!name.includes("__")) continue;
    if (!(await stat(join(JOBS_DIR, job, name)).catch(() => null))) continue;
    const r = await readJson(join(JOBS_DIR, job, name, "result.json"));
    const status = r?.verifier_result?.rewards?.reward != null ? "completed" : r?.exception_info ? "errored" : r?.finished_at ? "completed" : "running";
    // fmtError inlined as IIFE expression.
    const error = !r?.exception_info ? null
      : typeof r.exception_info === "string" ? r.exception_info.slice(0, 500)
      : ((ei: any) => { const t = ei?.exception_type ? String(ei.exception_type) : ""; const m = ei?.exception_message ? String(ei.exception_message) : ""; return (t ? (m ? t + ": " + m : t) : (m || JSON.stringify(ei))).slice(0, 500); })(r.exception_info);
    // trialFailover inlined.
    const key = job + "/" + name;
    const finished = !!r?.finished_at;
    let failover = false;
    if (finished && failoverCache.has(key)) failover = failoverCache.get(key)!;
    else {
      try {
        const p = join(JOBS_DIR, job, name, "agent", "pi.txt");
        const size = Bun.file(p).size;
        const text = size > 0 ? Buffer.from(await Bun.file(p).slice(Math.max(0, size - 32768), size).arrayBuffer()).toString("utf8") : "";
        failover = text.includes("provider-failover") || text.includes("no fallback candidate");
      } catch {}
      if (finished) failoverCache.set(key, failover);
    }
    trials.push({
      trial: name, task: (r?.task_name || name).replace(/^terminal-bench\//, ""), status,
      reward: r?.verifier_result?.rewards?.reward ?? null,
      in_tokens: r?.agent_result?.n_input_tokens ?? null,
      out_tokens: r?.agent_result?.n_output_tokens ?? null,
      cost_usd: r?.agent_result?.cost_usd ?? null,
      duration_s: r?.started_at && r?.finished_at ? Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000) : null,
      error,
      finished: r?.finished_at ?? null,
      failover,
    });
  }
  trials.sort((x, y) => x.task.localeCompare(y.task));
  return trials;
}

// ---- WS connection state ----
type Conn = { job: string; trial: string; tOff: number; rSig: string; tSig: string; trialW: FSWatcher | null; statW: FSWatcher | null };
const conns = new Map<any, Conn>();

function send(ws: any, type: string, data: any) { try { ws.send(JSON.stringify({ type, ...data })); } catch {} }

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => (t && clearTimeout(t), t = setTimeout(() => (t = null, fn()), ms));
}

// Shared watcher lifecycle (close + open), each used 3×/2×: net-positive DRY + keeps defensive try.
function closeW(w: FSWatcher | null) { if (w) { try { w.close(); } catch {} } }
function openW(p: string, fn: () => void, ms: number): FSWatcher | null {
  try { return watch(p, debounce(fn, ms)); } catch { return null; }
}

async function pushStats(ws: any, c: Conn) {
  const r = await readJson(join(JOBS_DIR, c.job, "result.json"));
  const sig = JSON.stringify(r?.stats ?? null);
  if (sig !== c.rSig) { c.rSig = sig; send(ws, "result", { result: r }); }
  const trials = await listTrials(c.job);
  const tsig = JSON.stringify(trials);
  if (tsig !== c.tSig) { c.tSig = tsig; send(ws, "trials", { trials }); }
}

// streamNew inlined: read new transcript bytes since tOff, push as events.
async function pushTranscript(ws: any, c: Conn) {
  if (!c.trial) return;
  const path = join(JOBS_DIR, c.job, c.trial, "agent", "pi.txt");
  const size = Bun.file(path).size;
  if (size < c.tOff) c.tOff = 0;
  if (size === c.tOff) return;
  const buf = Buffer.from(await Bun.file(path).slice(c.tOff, size).arrayBuffer());
  const lastNL = buf.lastIndexOf(0x0a);
  if (lastNL < 0) return;
  c.tOff += lastNL + 1;
  const events: any[] = [];
  for (const ln of buf.subarray(0, lastNL + 1).toString("utf8").split("\n"))
    if (ln) try { events.push(JSON.parse(ln)); } catch { events.push({ type: "raw", text: ln }); }
  if (events.length) send(ws, "transcript", { events, next: c.tOff });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  websocket: {
    open(ws: any) {
      const job = ws.data?.job;
      if (!job) return void ws.close(1008, "no job");
      const c: Conn = { job, trial: "", tOff: 0, rSig: "", tSig: "", trialW: null, statW: null };
      conns.set(ws, c);
      c.statW = openW(join(JOBS_DIR, c.job), () => pushStats(ws, c), 150); // openStatWatcher inlined
      pushStats(ws, c);
    },
    message(ws: any, msg: any) {
      const c = conns.get(ws); if (!c) return;
      try {
        const m = JSON.parse(msg.toString());
        if (m.type !== "select") return;
        c.trial = safeSeg(m.trial) || "";
        c.tOff = 0;
        send(ws, "select", { trial: c.trial }); // client clears view
        closeW(c.trialW); // closeTrialWatcher inlined
        pushTranscript(ws, c); // backfill from byte 0
        c.trialW = c.trial ? openW(join(JOBS_DIR, c.job, c.trial, "agent", "pi.txt"), () => pushTranscript(ws, c), 30) : null; // openTrialWatcher inlined
      } catch {}
    },
    close(ws: any) {
      const c = conns.get(ws);
      if (c) { closeW(c.trialW); closeW(c.statW); }
      conns.delete(ws);
    },
  },
  // REST router folded into fetch (handle was sole-use). Also serves static files.
  async fetch(req: Request, s: any) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      const job = safeSeg(u.searchParams.get("job"));
      if (!job) return new Response("bad job", { status: 400 });
      return s.upgrade(req, { data: { job } });
    }
    const p = u.pathname.split("/").filter(Boolean);
    const json = (o: any) => new Response(JSON.stringify(o), { headers: { "content-type": MIME[".json"], "cache-control": "no-store" } });
    // Static files (.html/.css/.js) served from HERE with no-store.
    const statName = p.length === 0 ? "index.html" : p[0];
    if (statName === "index.html" || statName === "styles.css" || statName === "app.js")
      return readFile(join(HERE, statName), "utf8")
        .then(s => new Response(s, { headers: { "content-type": MIME[statName.slice(statName.lastIndexOf("."))], "cache-control": "no-store" } }))
        .catch(() => new Response("not found", { status: 404 }));
    if (p[0] !== "api") return new Response("not found", { status: 404 });
    // listJobs inlined.
    if (p[1] === "jobs") {
      const out: { name: string; mtime: number }[] = [];
      for (const name of await readdir(JOBS_DIR).catch(() => [] as string[])) {
        const st = await stat(join(JOBS_DIR, name)).catch(() => null);
        if (st?.isDirectory()) out.push({ name, mtime: st.mtimeMs });
      }
      out.sort((x, y) => y.mtime - x.mtime);
      return json(out);
    }
    if (p[1] !== "job") return new Response("not found", { status: 404 });
    const j = safeSeg(p[2]);
    if (!j) return new Response("bad", { status: 400 });
    if (p[3] === "result") return json(await readJson(join(JOBS_DIR, j, "result.json")) ?? { error: "none" });
    if (p[3] === "trials") return json(await listTrials(j));
    // readLines inlined.
    if (p[3] === "log") {
      const after = Number(u.searchParams.get("after") ?? 0);
      const raw = await readFile(join(JOBS_DIR, j, "job.log"), "utf8").catch(() => null);
      if (raw === null) return json({ events: [], next: after, total: 0, missing: true });
      const lines = raw.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const start = Math.min(after, lines.length);
      const slice = lines.slice(start, start + CAP);
      const events: any[] = [];
      for (const ln of slice) if (ln) try { events.push(JSON.parse(ln)); } catch { events.push({ type: "raw", text: ln }); }
      return json({ events, next: start + slice.length, total: lines.length });
    }
    // readVerifier inlined.
    if (p[3] === "trial" && p[5] === "verifier") {
      const t = safeSeg(p[4]);
      if (!t) return new Response("bad", { status: 400 });
      const td = join(JOBS_DIR, j, t);
      const rd = (rel: string) => readFile(join(td, rel), "utf8").catch(() => null);
      return json({ reward: (await rd("verifier/reward.txt"))?.trim() ?? null, stdout: await rd("verifier/test-stdout.txt") });
    }
    return new Response("not found", { status: 404 });
  },
});

// fs.watch drives real-time streaming; the 1s intervals below are a safety
// backstop only, catching any missed filesystem events.
setInterval(() => { for (const [ws, c] of conns) pushTranscript(ws, c); }, 1000);
setInterval(() => { for (const [ws, c] of conns) pushStats(ws, c); }, 1000);

console.log(`TB2.1 WS monitor → ws://0.0.0.0:${PORT}/ws?job=<job>  (jobs: ${JOBS_DIR})`);
