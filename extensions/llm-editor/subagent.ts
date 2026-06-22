/**
 * Launch a `pi` CLI subagent for Viewer/Editor reasoning.
 *
 * Child argv (text print mode — NOT --mode json):
 *   pi --print --no-extensions -e subagent-transcript -e cost-tree
 *      --no-builtin-tools --no-session --no-context-files --no-skills
 *      --system-prompt <role> --provider <p> --model <m>
 * with the task (file contents + query/instruction) on stdin.
 *
 *   --no-extensions : no cpi extensions => no force-activated tools, no caveman
 *                     style transform, no recursion. Built-in providers + models.json still resolve.
 *                     subagent-transcript is re-added via `-e`: it streams the live markdown transcript
 *                     to stderr AND registers the role-gated completion tool.
 *   --no-builtin-tools : disables built-in read/bash/edit/write. The subagent's only tool is the
 *                     completion tool (view-complete / edit-complete) injected by llm-editor's
 *                     completion.ts (loaded via -e; subagent-transcript now only streams).
 *   --no-session     : ephemeral; nothing saved to /resume.
 *   --no-context-files / --no-skills : no AGENTS.md / skills appended.
 *   --system-prompt  : replace pi's default with the minimized role prompt.
 *
 * The subagent hands its result back as the ARGUMENTS of one completion tool call
 * (view-complete / edit-complete), which terminate:s the turn. That tool's execute
 * writes the structured args to $PI_SUBAGENT_COMPLETION (a temp file the parent
 * provisions); the parent reads it back after the child exits. No stdout/JSONL
 * reconstruction: text print-mode stdout is just the (empty) final assistant text,
 * and the live markdown transcript (incl. the rendered tool call) is the stderr
 * transcript of record. This drops the O(n^2) cumulative-message accumulation
 * that --mode json caused (the former ~512MB V8 string overflow).
 *
 * PI_SUBAGENT marks the child so cpi extensions can degrade; PI_SUBAGENT_ROLE
 * (viewer|editor) narrows which completion tool is registered. A missing
 * completion file means the subagent never called its tool => truncation.
 * Pure leaf: node child_process + os + fs + log.ts + text.ts + cost-ledger.
 */

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTranscript } from "./log.ts";
import { STREAM_UPDATE_MS } from "./render.ts";
import { loadEditorText, fmt } from "./text.ts";
import { parseSummaryUsage, type Usage } from "../lib/cost-ledger.ts";

const SUBAGENT_TRANSCRIPT_EXT = fileURLToPath(new URL("../subagent-transcript/index.ts", import.meta.url));
const COST_TREE_EXT = fileURLToPath(new URL("../cost-tree/index.ts", import.meta.url));
const COMPLETION_EXT = fileURLToPath(new URL("./completion.ts", import.meta.url));

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

/** The completion tool call the subagent ended its turn on: which tool + its
 *  parsed args. null = the subagent never called it (truncated/incomplete). */
export interface SubagentCompletion {
  tool: "view-complete" | "edit-complete";
  args: Record<string, unknown>;
}

export interface SubagentResult {
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  elapsedMs: number;
  usage?: Usage;
  completion: SubagentCompletion | null;
}

/** Read back the completion handoff file the child's completion tool wrote.
 *  Missing/empty/unparseable/wrong-shape => null (truncation). Best-effort. */
async function readCompletion(path: string): Promise<SubagentCompletion | null> {
  let raw: string;
  try {
    raw = (await readFile(path, "utf-8")).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as { tool?: string; args?: unknown };
    if (e.tool !== "view-complete" && e.tool !== "edit-complete") return null;
    if (!e.args || typeof e.args !== "object" || Array.isArray(e.args)) return null;
    return { tool: e.tool, args: e.args as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const T = loadEditorText(opts.cwd);
  const args = [
    "--print",
    "--no-extensions",
    "-e",
    SUBAGENT_TRANSCRIPT_EXT,
    "-e",
    COST_TREE_EXT,
    "-e",
    COMPLETION_EXT,
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
  // PI_SUBAGENT marks the child so cpi extensions can degrade (skip caveman
  // style / recursion); PI_SUBAGENT_ROLE narrows which completion tool registers
  // (viewer->view-complete, editor->edit-complete). The completion tool writes
  // its structured args to $PI_SUBAGENT_COMPLETION for the parent to read back.
  const completionPath = join(tmpdir(), `cpi-editor-${process.pid}-${Date.now()}.json`);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_SUBAGENT: "1",
    PI_SUBAGENT_ROLE: opts.role,
    PI_SUBAGENT_COMPLETION: completionPath,
  };
  const start = Date.now();
  const child = spawn("pi", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  // stdout is the (empty) final assistant text in print mode — drain, do not
  // parse. The payload rides the completion tool's args, not stdout, so there
  // is no O(n^2) cumulative-message accumulation (the former 512MB overflow).
  let stderr = "";
  let spawnError: string | undefined;
  let lastStreamUpd = 0;
  child.stdout.on("data", () => { /* drain */ });
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

  const completion = await readCompletion(completionPath);
  await unlink(completionPath).catch(() => {});
  const usage = parseSummaryUsage(stderr);

  const head =
    `${fmt(T.transcript.title, { role: opts.role })}\n\n` +
    `- model: ${opts.provider}/${opts.modelId}\n` +
    `- started: ${new Date(start).toISOString()}\n` +
    `- elapsed: ${elapsedMs}ms\n` +
    `- exit: ${exitCode}\n` +
    `- timed_out: ${timedOut}\n` +
    (spawnError ? `- spawn_error: ${spawnError}\n` : "") +
    `\n${T.transcript.section_system}\n\n${opts.systemPrompt}\n\n` +
    `${T.transcript.section_user}\n\n${opts.task}\n\n` +
    `${T.transcript.section_completion}\n\n${
      completion
        ? `\`\`\`json\n${JSON.stringify({ tool: completion.tool, args: completion.args }, null, 2)}\n\`\`\`\n`
        : `${T.messages.no_output}\n`
    }` +
    (stderr.trim() ? `\n${T.transcript.section_stderr}\n\n\`\`\`\n${stderr.trim()}\n\`\`\`\n` : "");

  await writeTranscript(opts.transcriptDir, opts.id, head, opts.maxTranscripts);
  return {
    stderr,
    exitCode,
    timedOut,
    spawnError,
    elapsedMs,
    usage,
    completion,
  };
}
