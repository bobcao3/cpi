/**
 * Out-of-band fork-probe: spawn `pi --fork <session> -p` with a prompt on
 * stdin; the child copies the full conversation to a throwaway session and
 * runs its own agent loop. The parent session is mutated only via the
 * consumer's `onSignal`, and only when `decide` returns a non-null signal —
 * on null or failure, "leave it be" is literal.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCwd } from "./cwd.ts";
import { resolvePiInvocation } from "./pi-invocation.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const KILL_GRACE_MS = 5000;
const MAX_STDOUT_BYTES = 1 * 1024 * 1024; // 1 MiB
const MAX_STDERR_BYTES = 256 * 1024; // 256 KiB
const MAX_PROMPT_BYTES = 256 * 1024; // 256 KiB
/** Marks a process as a fork-probe child; consumers read it to disable self-recursive probing. */
const FORK_PROBE_ENV = "CPI_FORK_PROBE";

export interface ForkSpawnOptions {
  /** Absolute parent session JSONL (ctx.sessionManager.getSessionFile()); `--fork` copies it in full. */
  parentSessionFile: string;
  command?: string;
  cwd?: string;
  model?: string;
  tools?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Throwaway temp session dir, removed on exit; set false to keep it for post-mortem. */
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
  assertc(typeof prompt === "string", "prompt must be a string");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  assertc(
    promptBytes <= MAX_PROMPT_BYTES,
    `prompt too large: ${promptBytes} > ${MAX_PROMPT_BYTES}`,
  );
  const timeoutMs = clamp(
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const ephemeral = opts.ephemeral !== false;

  const args: string[] = ["--fork", parentFile, "-p"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.tools) args.push("--tools", opts.tools);
  if (opts.appendSystemPrompt)
    args.push("--append-system-prompt", opts.appendSystemPrompt);

  let tmpSessionDir: string | undefined;
  if (ephemeral) {
    tmpSessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
    args.push("--session-dir", tmpSessionDir);
  }

  const cleanup = (): void => {
    if (tmpSessionDir) {
      try {
        rmSync(tmpSessionDir, { recursive: true, force: true });
      } catch {}
      tmpSessionDir = undefined;
    }
  };

  const invocation = resolvePiInvocation(args, opts.command);

  return new Promise<ForkProbeResult>((resolve) => {
    let proc: ChildProcess | undefined;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: opts.cwd ?? getCwd(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, [FORK_PROBE_ENV]: "1" },
        windowsHide: true,
      });
    } catch (err) {
      cleanup();
      resolve({
        ok: false,
        answer: "",
        exitCode: null,
        stderr: "",
        errorMessage: `spawn failed: ${errmsg(err)}`,
      });
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const armTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    };
    const finish = (result: ForkProbeResult): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      cleanup();
      resolve(result);
    };
    const killChild = (sig: NodeJS.Signals): void => {
      try {
        proc?.kill(sig);
      } catch {}
    };

    proc.stdout.on("data", (data: Buffer) => {
      const room = MAX_STDOUT_BYTES - Buffer.byteLength(stdoutText, "utf8");
      if (room <= 0) return;
      stdoutText += data.toString("utf8").slice(0, room);
    });
    proc.stderr.on("data", (data: Buffer) => {
      const room = MAX_STDERR_BYTES - Buffer.byteLength(stderrText, "utf8");
      if (room <= 0) return;
      stderrText += data.toString("utf8").slice(0, room);
    });
    proc.on("close", (code) => {
      const answer = stdoutText.trim();
      const ok = code === 0 && answer.length > 0;
      finish({
        ok,
        answer,
        exitCode: code,
        stderr: stderrText.trim(),
        errorMessage: ok
          ? undefined
          : stderrText.trim() || `fork probe exited ${code}`,
      });
    });
    proc.on("error", (err) => {
      finish({
        ok: false,
        answer: "",
        exitCode: null,
        stderr: stderrText.trim(),
        errorMessage: `spawn error: ${errmsg(err)}`,
      });
    });

    // Prompt via stdin (readPipedStdin): no ARG_MAX, no shell escaping.
    try {
      proc.stdin?.end(prompt, "utf8");
    } catch (err) {
      killChild("SIGTERM");
      armTimer(() => killChild("SIGKILL"), KILL_GRACE_MS);
      // Let close fire with whatever was produced; surface the write failure.
      armTimer(
        () =>
          finish({
            ok: false,
            answer: "",
            exitCode: null,
            stderr: stderrText.trim(),
            errorMessage: `stdin write failed: ${errmsg(err)}`,
          }),
        KILL_GRACE_MS + 100,
      );
      return;
    }

    armTimer(() => {
      killChild("SIGTERM");
      armTimer(() => killChild("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) {
        killChild("SIGTERM");
        armTimer(() => killChild("SIGKILL"), KILL_GRACE_MS);
      } else {
        opts.signal.addEventListener(
          "abort",
          () => {
            killChild("SIGTERM");
            armTimer(() => killChild("SIGKILL"), KILL_GRACE_MS);
          },
          { once: true },
        );
      }
    }
  });
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
