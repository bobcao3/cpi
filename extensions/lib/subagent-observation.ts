import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  appendActivityTail,
  finishActivity,
  updateActivity,
} from "./activity.ts";
import { createMarkdownWriter } from "./subagent-markdown.ts";
import { reserveTranscript } from "./subagent-artifacts.ts";
import {
  assertSubagentEvent,
  type SubagentRunEvent,
  type SubagentObservationOptions,
  type SubagentObservationResult,
} from "./subagent-events.ts";
import type { SubagentWorkerRequest } from "./subagent-rpc-protocol.ts";

export class SubagentObservation {
  readonly credits = new Int32Array(new SharedArrayBuffer(4));
  readonly result: SubagentObservationResult;
  options: SubagentObservationOptions = {};
  paused = false;
  private heldCredits = 0;
  private sequence = 0;
  private lastType = "";
  private turns = 0;
  private terminal?: Extract<SubagentRunEvent, { type: "terminal" }>;
  private closed = false;
  private markdownBytes = 0;
  private diagnosticBytes = 0;
  private markdownFile: number;
  private diagnosticFile: number;
  private releaseTranscript: () => void;
  private writer: ReturnType<typeof createMarkdownWriter>;
  private request: SubagentWorkerRequest;

  constructor(request: SubagentWorkerRequest) {
    this.request = request;
    const directory = join(
      request.env.PI_SESSION_DIR || join(getAgentDir(), "sessions"),
      "subagent-transcripts",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const base = join(directory, `${Date.now()}-${request.runId}`);
    this.result = {
      finalAnswer: "",
      markdownPath: `${base}.md`,
      diagnosticsPath: `${base}.stderr`,
    };
    this.releaseTranscript = reserveTranscript(base, directory);
    try {
      this.markdownFile = openSync(this.result.markdownPath, "wx", 0o600);
      this.diagnosticFile = openSync(this.result.diagnosticsPath, "wx", 0o600);
    } catch (error) {
      if (this.markdownFile !== undefined) closeSync(this.markdownFile);
      this.releaseTranscript();
      throw error;
    }
    this.writer = createMarkdownWriter((chunk) => {
      this.markdownBytes += Buffer.byteLength(chunk);
      if (this.markdownBytes > 32 * 1024 * 1024)
        throw new Error("subagent markdown limit exceeded");
      writeSync(this.markdownFile, chunk);
      appendActivityTail(request.runId, chunk);
      updateActivity(request.runId, {
        metrics: { output_bytes: this.markdownBytes },
      });
      this.options.onMarkdown?.(chunk);
    });
  }

  diagnostic(chunk: Buffer): void {
    if (this.closed) return;
    const room = Math.max(0, 1024 * 1024 - this.diagnosticBytes);
    if (room) writeSync(this.diagnosticFile, chunk.subarray(0, room));
    this.diagnosticBytes += chunk.length;
    updateActivity(this.request.runId, {
      metrics: {
        diagnostic_bytes: this.diagnosticBytes,
        diagnostic: chunk.toString("utf8").slice(-1024),
        ...(this.diagnosticBytes > 1024 * 1024
          ? { diagnostics_truncated: 1 }
          : {}),
      },
    });
  }

  receive(message: unknown): boolean {
    if ((message as { kind?: string })?.kind !== "run_event") return false;
    try {
      if (this.closed || this.terminal)
        throw new Error("subagent observation after terminal");
      assertSubagentEvent(message, this.request.runId, this.sequence + 1);
      this.sequence++;
      if (this.sequence > 100000)
        throw new Error("subagent observation event limit");
      if (message.type === "terminal") {
        if (this.lastType !== "usage")
          throw new Error("subagent terminal before final usage");
        this.terminal = message;
        this.result.finalAnswer = message.answer;
        return true;
      }
      this.lastType = message.type;
      if (message.type === "usage") {
        const old = this.result.usage;
        if (
          old &&
          (message.usage.input < old.input ||
            message.usage.output < old.output ||
            message.usage.cost < old.cost)
        )
          throw new Error("subagent cumulative usage decreased");
        this.result.usage = message.usage;
        this.turns = message.turns;
        updateActivity(this.request.runId, {
          metrics: {
            ...message.usage,
            turns: message.turns,
            usage_scope: "self",
          },
        });
      } else if (message.type === "session") {
        updateActivity(this.request.runId, {
          log_path: this.result.markdownPath,
          metrics: {
            child_session_id: message.sessionId,
            session_file: message.sessionFile ?? "",
            model: message.model,
            effort: message.effort,
            markdown_path: this.result.markdownPath,
            diagnostics_path: this.result.diagnosticsPath,
          },
        });
      } else if (message.type === "diagnostic") {
        updateActivity(this.request.runId, {
          metrics: { diagnostic: message.message.slice(-1024) },
        });
      }
      this.writer.event(message);
      this.options.onEvent?.(message);
      return true;
    } finally {
      if (this.paused) this.heldCredits++;
      else {
        Atomics.sub(this.credits, 0, 1);
        Atomics.notify(this.credits, 0);
      }
    }
  }

  resume(): void {
    this.paused = false;
    Atomics.sub(this.credits, 0, this.heldCredits);
    this.heldCredits = 0;
    Atomics.notify(this.credits, 0);
  }

  finish(
    exitCode: number | null,
    cancelled: boolean,
    error?: string,
  ): Error | undefined {
    if (this.closed) return;
    this.closed = true;
    for (const operation of [
      () => this.writer.close(),
      () => fsyncSync(this.markdownFile),
      () => fsyncSync(this.diagnosticFile),
      () => closeSync(this.markdownFile),
      () => closeSync(this.diagnosticFile),
      () => this.releaseTranscript(),
    ]) {
      try {
        operation();
      } catch (value) {
        error ??= String(value);
      }
    }
    if (!this.terminal) {
      this.result.usage ??= { input: 0, output: 0, cost: 0 };
      try {
        this.options.onEvent?.({
          kind: "run_event",
          version: 1,
          runId: this.request.runId,
          sequence: ++this.sequence,
          type: "usage",
          usage: this.result.usage,
          scope: "self",
          turns: this.turns,
        });
      } catch (value) {
        error ??= String(value);
      }
    }
    const outcome = error
      ? "failed"
      : cancelled
        ? "cancelled"
        : exitCode === 0 && this.terminal?.outcome === "completed"
          ? "completed"
          : "failed";
    const failure =
      error ??
      (outcome === "failed"
        ? (this.terminal?.error ??
          "worker exited without a successful terminal observation")
        : undefined);
    finishActivity(this.request.runId, outcome, {
      exit_code: exitCode ?? "unknown",
      ...(failure ? { diagnostic: failure } : {}),
    });
    try {
      this.options.onEvent?.({
        kind: "run_event",
        version: 1,
        runId: this.request.runId,
        sequence: this.terminal?.sequence ?? ++this.sequence,
        type: "terminal",
        outcome,
        answer: this.result.finalAnswer,
        ...(failure ? { error: failure } : {}),
      });
    } catch (value) {
      return new Error(String(value));
    }
    return failure && (error || !this.terminal || exitCode === 0)
      ? new Error(failure)
      : undefined;
  }
}
