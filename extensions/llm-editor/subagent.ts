/**
 * Run a minimized SDK AgentSession in the root-owned subagent RPC worker (no
 * nested Pi CLI/process), which may continue with bounded correction turns in
 * the same conversation, with no builtins, persisted session, context files, or skills.
 * Role-gated completion uses a handoff file; direct mode returns text.
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTranscript } from "./log.ts";
import { getActivitySession, updateActivity } from "../lib/activity.ts";
import { STREAM_UPDATE_MS } from "./render.ts";
import { loadEditorText, fmt, type EditorText } from "./text.ts";
import { parseSummaryUsage, type Usage } from "../lib/cost-ledger.ts";
import {
  runSubagentWorker,
  type SubagentCandidate as SessionCandidate,
  type SessionSubagentRequest,
} from "../lib/subagent-rpc.ts";
import {
  validSubagentCandidate,
  validSubagentContinuationPrompt,
} from "../lib/subagent-rpc-protocol.ts";

export interface SubagentOptions {
  role: "viewer" | "editor";
  title: string;
  systemPrompt: string;
  task: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  outputMode?: "tool-call" | "text";
  maxOutputBytes?: number;
  maxCorrectionTurns?: number;
  /** Return a correction to continue the same session; undefined finishes. */
  onCandidate?: (candidate: SubagentCandidate) => string | undefined;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  transcriptDir: string;
  id: string;
  maxTranscripts: number;
  onStream?: (accumulated: string) => void;
}

/** The completion tool call the subagent ended on; null = it never called it (truncated). */
export interface SubagentCompletion {
  tool: "view-complete" | "edit-complete";
  args: Record<string, unknown>;
}

export interface SubagentCandidate extends SessionCandidate {
  completion: SubagentCompletion | null;
}

export interface SubagentResult {
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  elapsedMs: number;
  usage?: Usage;
  completion: SubagentCompletion | null;
  text: string;
  outputOverflow: boolean;
  aborted: boolean;
  turns: number;
}

interface RecordedTurn {
  candidate: SubagentCandidate;
  correction?: string;
}

function renderTurn(T: EditorText, record: RecordedTurn): string {
  const { candidate } = record;
  let rendered =
    `${fmt(T.transcript.section_completion_turn, { turn: candidate.turn + 1 })}\n\n` +
    (candidate.completion
      ? `\`\`\`json\n${JSON.stringify(
          {
            tool: candidate.completion.tool,
            args: candidate.completion.args,
          },
          null,
          2,
        )}\n\`\`\`\n`
      : candidate.text.trim()
        ? `\`\`\`diff\n${candidate.text.trim()}\n\`\`\`\n`
        : `${T.messages.no_output}\n`);
  if (record.correction !== undefined) {
    rendered += `\n${fmt(T.transcript.section_correction_turn, {
      turn: candidate.turn + 1,
    })}\n\n${record.correction}`;
  }
  return `${rendered}\n`;
}

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function runSubagent(
  opts: SubagentOptions,
): Promise<SubagentResult> {
  const T = loadEditorText(opts.cwd);
  const outputMode = opts.outputMode ?? "tool-call";
  const maxOutputBytes = opts.maxOutputBytes ?? 524288;
  const maxCorrectionTurns = opts.maxCorrectionTurns ?? 0;
  const completionPath =
    outputMode === "tool-call"
      ? join(tmpdir(), `cpi-editor-${process.pid}-${randomUUID()}.json`)
      : undefined;
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionPaths = [
    join(extensionRoot, "subagent-transcript/index.ts"),
    join(extensionRoot, "cost-tree/index.ts"),
  ];
  const env = inheritedEnvironment();
  const ownerSession = getActivitySession();
  if (ownerSession) env.PI_SESSION_ID = ownerSession;
  env.PI_SUBAGENT_ROLE = opts.role;
  env.PI_SUBAGENT_CWD = opts.cwd;
  if (completionPath) {
    extensionPaths.push(join(extensionRoot, "llm-editor/completion.ts"));
    env.PI_SUBAGENT_COMPLETION = completionPath;
  } else {
    delete env.PI_SUBAGENT_COMPLETION;
  }
  const request: SessionSubagentRequest = {
    version: 1,
    kind: "session",
    cacheRetention: "none",
    extensionPaths,
    completionTool:
      outputMode === "tool-call"
        ? opts.role === "viewer"
          ? "view-complete"
          : "edit-complete"
        : undefined,
    runId: randomUUID(),
    systemPrompt: opts.systemPrompt,
    task: opts.task,
    title: opts.title,
    provider: opts.provider,
    modelId: opts.modelId,
    thinkingLevel: opts.thinkingLevel,
    cwd: opts.cwd,
    outputMode,
    completionPath,
    maxTurns: maxCorrectionTurns + 1,
    maxOutputBytes,
    env,
  };
  const start = Date.now();
  let stderr = "";
  const turns: RecordedTurn[] = [];
  let lastCandidate: SubagentCandidate | undefined;
  let lastStreamUpd = 0;
  let expectedTurn = 0;
  let sentFinish = false;
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          updateActivity(request.runId, { metrics: { timed_out: 1 } });
          controller.abort();
        }, opts.timeoutMs)
      : undefined;
  const onAbort = (): void => {
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const result = await runSubagentWorker(request, {
    signal: controller.signal,
    stderr(chunk) {
      stderr += chunk.toString("utf8");
      const now = Date.now();
      if (now - lastStreamUpd >= STREAM_UPDATE_MS) {
        lastStreamUpd = now;
        opts.onStream?.(stderr);
      }
    },
    onMessage(message) {
      if (
        sentFinish ||
        !validSubagentCandidate(message, request) ||
        message.turn !== expectedTurn
      ) {
        throw new Error("invalid llm-editor candidate");
      }
      expectedTurn++;
      if (controller.signal.aborted) {
        sentFinish = true;
        return { kind: "finish" };
      }
      const candidate = message as SubagentCandidate;
      lastCandidate = candidate;
      const correction = opts.onCandidate?.(candidate);
      turns.push({ candidate, correction });
      if (correction === undefined) {
        sentFinish = true;
        return { kind: "finish" };
      }
      if (
        expectedTurn >= request.maxTurns ||
        !validSubagentContinuationPrompt(correction)
      ) {
        throw new Error("invalid llm-editor correction decision");
      }
      return { kind: "continue", prompt: correction };
    },
  });
  if (timer) clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  const exitCode = result.exitCode;
  const spawnError = result.error?.message;
  const elapsedMs = Date.now() - start;

  const text = lastCandidate?.text ?? "";
  const completion = lastCandidate?.completion ?? null;
  const outputOverflow = lastCandidate?.outputOverflow ?? false;
  const aborted = opts.signal?.aborted === true && !timedOut;
  if (completionPath) {
    await unlink(completionPath).catch(() => {});
  }
  const usage = parseSummaryUsage(stderr);

  const head =
    `${fmt(T.transcript.title, { role: opts.role, title: opts.title })}\n\n` +
    `- model: ${opts.provider}/${opts.modelId}\n` +
    // Without this a failed edit cannot be attributed to the model tier that produced it: the pick is chain-resolved and may downgrade effort silently.
    `- thinking: ${opts.thinkingLevel ?? "(unset)"}\n` +
    `- started: ${new Date(start).toISOString()}\n` +
    `- elapsed: ${elapsedMs}ms\n` +
    `- exit: ${exitCode}\n` +
    `- timed_out: ${timedOut}\n` +
    `- aborted: ${aborted}\n` +
    `- turns: ${turns.length}\n` +
    `- correction_turns: ${turns.filter((turn) => turn.correction !== undefined).length}\n` +
    `- output_mode: ${outputMode}\n` +
    `- output_overflow: ${outputOverflow}\n` +
    (spawnError ? `- spawn_error: ${spawnError}\n` : "") +
    `\n${T.transcript.section_system}\n\n${opts.systemPrompt}\n\n` +
    `${T.transcript.section_user}\n\n${opts.task}\n\n` +
    (turns.length > 0
      ? turns.map((turn) => renderTurn(T, turn)).join("\n")
      : `${T.transcript.section_completion}\n\n${T.messages.no_output}\n`) +
    (stderr.trim()
      ? `\n${T.transcript.section_stderr}\n\n\`\`\`\n${stderr.trim()}\n\`\`\`\n`
      : "");

  const transcriptPath = await writeTranscript(
    opts.transcriptDir,
    opts.id,
    head,
    opts.maxTranscripts,
  );
  updateActivity(request.runId, {
    log_path: transcriptPath,
    metrics: {
      elapsed_ms: elapsedMs,
      turns: turns.length,
      timed_out: timedOut ? 1 : 0,
      aborted: aborted ? 1 : 0,
      ...(usage
        ? { input: usage.input, output: usage.output, cost: usage.cost }
        : {}),
    },
  });
  return {
    stderr,
    text,
    exitCode,
    timedOut,
    spawnError,
    elapsedMs,
    usage,
    completion,
    outputOverflow,
    aborted,
    turns: turns.length,
  };
}
