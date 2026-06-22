/**
 * Launch a tool-less `pi` CLI subagent for Viewer/Editor reasoning.
 *
 * Child argv:
 *   pi --print --no-extensions --no-tools --no-session --no-context-files
 *      --no-skills --system-prompt <role> --provider <p> --model <m>
 * with the task (file contents + query/instruction) on stdin.
 *
*   --no-extensions : no cpi extensions → no force-activated tools, no caveman
*                     style transform, no recursion. Built-in providers + models.json still resolve.
*                     The subagent-transcript ext is re-added via `-e` (streaming only; no caveman/style transforms).
 *   --no-tools       : disables built-in read/bash/edit/write too. Fully tool-less.
 *   --no-session     : ephemeral; nothing saved to /resume.
 *   --no-context-files / --no-skills : no AGENTS.md / skills appended.
 *   --system-prompt  : replace pi's default with the minimized role prompt.
 *
 * Print-mode stdout is ONLY the final assistant message (takeOverStdout routes
 * everything else to stderr), so stdout = the structured answer to parse.
 * Transcript (single-turn) is rendered from text.toml labels and persisted as `<id>.md`.
 * Pure leaf: node + log.ts + text.ts.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeTranscript } from "./log.ts";
import { STREAM_UPDATE_MS } from "./render.ts";
import { loadEditorText, fmt } from "./text.ts";
import { parseSummaryUsage, type Usage } from "../lib/cost-ledger.ts";

const SUBAGENT_TRANSCRIPT_EXT = fileURLToPath(new URL("../subagent-transcript/index.ts", import.meta.url));
const COST_TREE_EXT = fileURLToPath(new URL("../cost-tree/index.ts", import.meta.url));

export interface SubagentOptions {
  role: "viewer" | "editor";
  systemPrompt: string;
  task: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  transcriptDir: string;
  id: string;
  maxTranscripts: number;
  onStream?: (accumulated: string) => void;
}

export interface SubagentResult {
  answer: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  elapsedMs: number;
  usage?: Usage;
  editAction: "apply" | "cancel" | null;
}

/** Parse the subagent's JSONL stdout for the assistant text answer + edit-complete action. */
function parseSubagentJsonl(stdout: string): { answer: string; editAction: "apply" | "cancel" | null } {
  let answer = "";
  let editAction: "apply" | "cancel" | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "message_end") continue;
    const m = e.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") answer += c.text;
      if (c.type === "toolCall" && c.name === "edit-complete") {
        let a = c.arguments;
        if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
        if (a && (a.action === "apply" || a.action === "cancel")) editAction = a.action;
      }
    }
  }
  return { answer: answer.trim(), editAction };
}

export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const T = loadEditorText(opts.cwd);
  const args = [
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    "-e",
    SUBAGENT_TRANSCRIPT_EXT,
    "-e",
    COST_TREE_EXT,
    "--no-builtin-tools",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--system-prompt",
    opts.systemPrompt,
    "--provider",
    opts.provider,
    "--model",
    opts.modelId,
  ];
  if (opts.thinkingLevel) {
    args.push("--thinking", opts.thinkingLevel);
  }
  // PI_SUBAGENT marks the child so cpi extensions can degrade (e.g. skip
  // caveman style / recursion).
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
  const start = Date.now();
  const child = spawn("pi", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  let stdout = "";
  let stderr = "";
  let spawnError: string | undefined;
  let lastStreamUpd = 0;
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
    const now = Date.now();
    if (now - lastStreamUpd >= STREAM_UPDATE_MS) {
      lastStreamUpd = now;
      opts.onStream?.(stderr);
    }
  });
  child.stdin.end(opts.task);

  let timedOut = false;
  const timer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
  const onAbort = (): void => { child.kill("SIGKILL"); };
  if (opts.signal) {
    if (opts.signal.aborted) child.kill("SIGKILL");
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err.message;
      resolve(null);
    });
  });
  if (timer) clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  const elapsedMs = Date.now() - start;

  // JSONL mode: parse the assistant text (search-replace block) + edit-complete
  // action from the structured stdout (terminate:true empties text-mode stdout).
  const { answer, editAction } = parseSubagentJsonl(stdout);

  const body =
    `${fmt(T.transcript.title, { role: opts.role })}\n\n` +
    `- model: ${opts.provider}/${opts.modelId}\n` +
    `- started: ${new Date(start).toISOString()}\n` +
    `- elapsed: ${elapsedMs}ms\n` +
    `- exit: ${exitCode}\n` +
    `- timed_out: ${timedOut}\n` +
    (spawnError ? `- spawn_error: ${spawnError}\n` : "") +
    `\n${T.transcript.section_system}\n\n${opts.systemPrompt}\n\n` +
    `${T.transcript.section_user}\n\n${opts.task}\n\n` +
    `${T.transcript.section_assistant}\n\n${answer || T.messages.no_output}\n` +
    (stderr.trim() ? `\n${T.transcript.section_stderr}\n\n\`\`\`\n${stderr.trim()}\n\`\`\`\n` : "");

  await writeTranscript(opts.transcriptDir, opts.id, body, opts.maxTranscripts);
  const usage = parseSummaryUsage(stderr);
  return { answer, stderr, exitCode, timedOut, spawnError, elapsedMs, usage, editAction };
}
