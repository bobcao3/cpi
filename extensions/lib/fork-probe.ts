/**
 * A root-owned SDK Worker uses `SessionManager.forkFrom` with a prompt.
 * It copies the conversation into an isolated temporary session.
 * The worker inherits its parent provider prompt-cache identity.
 * Only a non-null `decide` result lets `onSignal` mutate the
 * parent; null/failure leaves it untouched.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCwd } from "./cwd.ts";
import {
  runSubagentWorker,
  type ForkProbeSubagentRequest,
} from "./subagent-rpc.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_STDOUT_BYTES = 1 * 1024 * 1024; // 1 MiB
const MAX_STDERR_BYTES = 256 * 1024; // 256 KiB
const MAX_PROMPT_BYTES = 256 * 1024; // 256 KiB
const MAX_SESSION_HEADER_BYTES = 16 * 1024; // 16 KiB

export interface ForkSpawnOptions {
  /** Absolute parent session JSONL (ctx.sessionManager.getSessionFile()); `SessionManager.forkFrom` copies it in full. */
  parentSessionFile: string;
  cwd?: string;
  model?: string;
  tools?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Unique temp session dir; removed on exit unless false, which retains it for post-mortem. */
  ephemeral?: boolean;
}

export interface ForkProbeResult {
  ok: boolean;
  answer: string;
  exitCode: number | null;
  stderr: string;
  errorMessage?: string;
}

export interface ForkGateOptions<TSignal> extends ForkSpawnOptions {
  prompt: string;
  /** Parse the answer into a signal; null/undefined = leave it be (no append). */
  decide: (answer: string) => TSignal | null | undefined;
  onSignal: (signal: TSignal, answer: string) => void;
}

export interface ForkGateOutcome<TSignal> {
  ok: boolean;
  answer: string;
  signal: TSignal | null;
  appended: boolean;
  errorMessage?: string;
}

function assertc(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`[cpi-fork-probe] ${message}`);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function errmsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function boundedOutput(limit: number) {
  const buffer = Buffer.allocUnsafe(limit);
  let length = 0;
  return {
    write(chunk: Buffer): void {
      const toCopy = Math.min(limit - length, chunk.length);
      if (toCopy <= 0) return;
      chunk.copy(buffer, length, 0, toCopy);
      length += toCopy;
    },
    text(): string {
      return buffer.subarray(0, length).toString("utf8");
    },
  };
}

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function readParentSessionId(parentFile: string): string {
  const fd = openSync(parentFile, "r");
  try {
    const header = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    let length = 0;
    let foundLf = false;
    while (length < header.length) {
      const bytesRead = readSync(
        fd,
        header,
        length,
        header.length - length,
        null,
      );
      if (bytesRead === 0) break;
      const chunk = header.subarray(length, length + bytesRead);
      const lf = chunk.indexOf(0x0a);
      if (lf !== -1) {
        length += lf;
        foundLf = true;
        break;
      }
      length += bytesRead;
    }
    assertc(
      foundLf || length < header.length,
      `parent session header exceeds ${MAX_SESSION_HEADER_BYTES} bytes`,
    );
    let session: unknown;
    try {
      session = JSON.parse(header.subarray(0, length).toString("utf8"));
    } catch (err) {
      throw new Error(
        `[cpi-fork-probe] failed to parse parent session header: ${errmsg(err)}`,
      );
    }
    assertc(
      session !== null &&
        typeof session === "object" &&
        !Array.isArray(session),
      "parent session header must be a record",
    );
    const record = session as Record<string, unknown>;
    assertc(
      record.type === "session",
      "parent session header must be a session",
    );
    assertc(
      typeof record.id === "string" &&
        /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(record.id),
      "parent session header has an invalid id",
    );
    return record.id;
  } finally {
    closeSync(fd);
  }
}

/** Never rejects: failures come back as `ok:false` so callers can leave it be without try/catch. */
export async function runForkProbe(
  opts: ForkSpawnOptions,
  prompt: string,
): Promise<ForkProbeResult> {
  assertc(
    typeof opts?.parentSessionFile === "string" && opts.parentSessionFile,
    "parentSessionFile required",
  );
  const parentFile = realpathSafe(opts.parentSessionFile);
  assertc(
    existsSync(parentFile),
    `parent session file not found: ${opts.parentSessionFile}`,
  );
  const parentSessionId = readParentSessionId(parentFile);
  assertc(typeof prompt === "string", "prompt must be a string");
  assertc(prompt.length > 0, "prompt required");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  assertc(
    promptBytes <= MAX_PROMPT_BYTES,
    `prompt too large: ${promptBytes} > ${MAX_PROMPT_BYTES}`,
  );
  assertc(
    Buffer.byteLength(parentSessionId, "utf8") <= 128,
    "parent session id too large",
  );
  const timeoutMs = clamp(
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const ephemeral = opts.ephemeral !== false;

  const tmpSessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
  const cleanup = (): void => {
    if (!ephemeral) return;
    try {
      rmSync(tmpSessionDir, { recursive: true, force: true });
    } catch {}
  };

  const request: ForkProbeSubagentRequest = {
    version: 1,
    kind: "fork-probe",
    parentSessionFile: parentFile,
    parentSessionId,
    sessionDir: tmpSessionDir,
    prompt,
    cwd: opts.cwd ?? getCwd(),
    env: inheritedEnvironment(),
    runId: randomUUID(),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.appendSystemPrompt
      ? { appendSystemPrompt: opts.appendSystemPrompt }
      : {}),
  };
  const stdout = boundedOutput(MAX_STDOUT_BYTES);
  const stderr = boundedOutput(MAX_STDERR_BYTES);
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = (): void => {
    callerAborted = true;
    controller.abort();
  };
  let callerListenerAdded = false;
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortFromCaller();
    } else {
      opts.signal.addEventListener("abort", abortFromCaller, { once: true });
      callerListenerAdded = true;
    }
  }

  let result: Awaited<ReturnType<typeof runSubagentWorker>> | undefined;
  let workerError: unknown;
  try {
    result = await runSubagentWorker(request, {
      signal: controller.signal,
      stdout: stdout.write,
      stderr: stderr.write,
    });
  } catch (error) {
    workerError = error;
  } finally {
    clearTimeout(timeout);
    if (callerListenerAdded)
      opts.signal?.removeEventListener("abort", abortFromCaller);
    cleanup();
  }

  const answer = stdout.text().trim();
  const stderrText = stderr.text().trim();
  if (workerError !== undefined) {
    return {
      ok: false,
      answer,
      exitCode: null,
      stderr: stderrText,
      errorMessage: `worker failed: ${errmsg(workerError)}`,
    };
  }

  const exitCode = result!.exitCode;
  const transportError = result!.error;
  const ok =
    !controller.signal.aborted &&
    !transportError &&
    exitCode === 0 &&
    answer.length > 0;
  return {
    ok,
    answer,
    exitCode,
    stderr: stderrText,
    errorMessage: ok
      ? undefined
      : timedOut
        ? `fork probe timed out after ${timeoutMs}ms`
        : callerAborted
          ? "fork probe aborted"
          : transportError
            ? transportError.message
            : stderrText ||
              (exitCode === 0 && !answer
                ? "fork probe returned no answer"
                : `fork probe exited ${exitCode}`),
  };
}

export async function forkGate<TSignal>(
  opts: ForkGateOptions<TSignal>,
): Promise<ForkGateOutcome<TSignal>> {
  assertc(typeof opts?.prompt === "string", "prompt required");
  assertc(typeof opts?.decide === "function", "decide required");
  assertc(typeof opts?.onSignal === "function", "onSignal required");

  const result = await runForkProbe(opts, opts.prompt);
  if (!result.ok) {
    return {
      ok: false,
      answer: result.answer,
      signal: null,
      appended: false,
      errorMessage: result.errorMessage,
    };
  }
  const signal = opts.decide(result.answer);
  if (signal === null || signal === undefined) {
    return { ok: true, answer: result.answer, signal: null, appended: false };
  }
  opts.onSignal(signal, result.answer);
  return { ok: true, answer: result.answer, signal, appended: true };
}
