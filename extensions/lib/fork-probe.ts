/**
 * Out-of-band fork-probe — the generic "fork → signal → append-or-leave-be"
 * primitive. Anti-stuck (and any other policy) is just a consumer.
 *
 * Spawns a child `pi --fork <parentSessionFile> -p` with a caller-supplied
 * prompt piped on stdin. `--fork` → `SessionManager.forkFrom` writes a FULL
 * copy of the parent's conversation into a throwaway `--session-dir`, and the
 * child runs its own agent loop there — so it can call tools (sh, read, …) to
 * investigate before answering. The parent session is not touched for the
 * duration; only the caller's `onSignal` effect (typically `pi.sendUserMessage`)
 * mutates the original, and ONLY when `decide` returns a non-null signal. On a
 * null signal — or a failed probe — the original session receives nothing:
 * "leave it be" is literal.
 *
 * Design notes:
 *   - Pure capability. No `pi` import, no handler/renderer registration, no
 *     shared mutable state (each probe is independent). The consumer owns the
 *     `pi` handle and the append action; it passes a `decide` predicate and an
 *     `onSignal` effect. Mirrors lib/notification.ts (stateless fn taking its
 *     dependencies as args), not lib/session-hold.ts (globalThis state).
 *   - Prompt-agnostic. This module holds NO model-facing text (per AGENTS.md
 *     rule 4: prompts live in extensions/text/ as TOML). The consumer renders
 *     its prompt and passes the string in.
 *   - Text mode (not json): stdout is the child's final assistant text, so the
 *     harvest is one `trim()` — no coupling to pi's internal event schema
 *     (the json-mode coupling flagged in the subagent extension).
 *   - Explicit limits everywhere (TigerStyle): bounded wall-clock, bounded
 *     stdout/stderr/prompt sizes, SIGTERM→SIGKILL grace, no recursion, no
 *     unbounded waits. Assertions check preconditions and invariants.
 *
 * Recursion: the child inherits the parent's extensions. A consumer that can
 * itself trigger a fork-probe (e.g. anti-stuck) must disable itself in children
 * (e.g. via an env var) — that is consumer policy, not this module's concern.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Constants (explicit limits, per TigerStyle) ─────────────────────────────

/** Default wall-clock bound for the child. Bounds the probe. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
/** Hard cap on the wall-clock bound. A probe may never run longer than this. */
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
/** SIGTERM→SIGKILL grace window when aborting the child. */
const KILL_GRACE_MS = 5000;
/** Bound stdout so a runaway child cannot OOM the parent. The answer is a tiny
 *  token (e.g. TRUE/FALSE); this is a safety bound, not a working buffer. */
const MAX_STDOUT_BYTES = 1 * 1024 * 1024; // 1 MiB
/** Bound stderr (diagnostics only). */
const MAX_STDERR_BYTES = 256 * 1024; // 256 KiB
/** Bound prompt size (piped via stdin; --fork already copied full history). */
const MAX_PROMPT_BYTES = 256 * 1024; // 256 KiB

// ── Types ───────────────────────────────────────────────────────────────────

export interface ForkSpawnOptions {
  /** Absolute path to the parent session JSONL — from
   *  `ctx.sessionManager.getSessionFile()`. `--fork` copies it in full. */
  parentSessionFile: string;
  /** Override the auto-resolved `pi` binary. When set, this command is used
   *  directly with the built args — useful for tests or pinning a specific
   *  pi executable. When unset, the runtime + entry script are auto-detected. */
  command?: string;
  /** Working directory for the child (defaults to `process.cwd()`). */
  cwd?: string;
  /** Optional `--model` override for the child. */
  model?: string;
  /** Optional `--tools` csv to restrict the child's toolset. */
  tools?: string;
  /** Optional `--append-system-prompt` (literal text or a file path — pi reads
   *  the file if it exists, else treats as literal). */
  appendSystemPrompt?: string;
  /** Wall-clock bound in ms, clamped to [1, MAX_TIMEOUT_MS]. Default 5 min. */
  timeoutMs?: number;
  /** Abort the child when this signal aborts. Resolves on the child's exit. */
  signal?: AbortSignal;
  /** When true (default), the fork is written to a throwaway temp dir which is
   *  removed after the child exits — no /resume clutter, no JSON coupling.
   *  Set false to keep the fork session on disk for post-mortem inspection. */
  ephemeral?: boolean;
}

export interface ForkProbeResult {
  /** true iff the child exited 0 and produced a non-empty final assistant text. */
  ok: boolean;
  /** The child's final assistant text (text-mode stdout), trimmed. */
  answer: string;
  exitCode: number | null;
  stderr: string;
  /** Set when `ok` is false. */
  errorMessage?: string;
}

export interface ForkGateOptions<TSignal> extends ForkSpawnOptions {
  /** The prompt for the fork child. Caller renders this from extensions/text/. */
  prompt: string;
  /** Parse the child's answer into a signal. Return null/undefined to "leave it
   *  be" (no append). Any non-null value triggers `onSignal`. */
  decide: (answer: string) => TSignal | null | undefined;
  /** Effect run when `decide` returns a non-null signal — typically appends to
   *  the original session via `pi.sendUserMessage`. NOT called on a null signal
   *  or a failed probe. Receives the signal and the raw answer. */
  onSignal: (signal: TSignal, answer: string) => void;
}

export interface ForkGateOutcome<TSignal> {
  ok: boolean;
  answer: string;
  /** The signal `decide` returned, or null (leave it be / probe failed). */
  signal: TSignal | null;
  /** true iff `onSignal` was called. */
  appended: boolean;
  errorMessage?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** Resolve the `pi` binary the same way the subagent extension does: reuse the
 *  running runtime + entry script when available, else fall back to `pi`. */
function resolvePiInvocation(args: string[], overrideCommand?: string): { command: string; args: string[] } {
  if (overrideCommand) return { command: overrideCommand, args };
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

// ── runForkProbe ────────────────────────────────────────────────────────────

/**
 * Spawn a forked `pi` child with `prompt` on stdin, run its agent loop to
 * completion, and harvest the final assistant text. The parent session is not
 * modified. Resolves on the child's exit (or abort), never rejects — failures
 * are reported via `ok: false` so callers can "leave it be" without try/catch.
 */
export async function runForkProbe(
  opts: ForkSpawnOptions,
  prompt: string,
): Promise<ForkProbeResult> {
  assertc(typeof opts?.parentSessionFile === "string" && opts.parentSessionFile, "parentSessionFile required");
  const parentFile = realpathSafe(opts.parentSessionFile);
  assertc(existsSync(parentFile), `parent session file not found: ${opts.parentSessionFile}`);
  assertc(typeof prompt === "string", "prompt must be a string");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  assertc(promptBytes <= MAX_PROMPT_BYTES, `prompt too large: ${promptBytes} > ${MAX_PROMPT_BYTES}`);
  const timeoutMs = clamp(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const ephemeral = opts.ephemeral !== false;

  const args: string[] = ["--fork", parentFile, "-p"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.tools) args.push("--tools", opts.tools);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);

  let tmpSessionDir: string | undefined;
  if (ephemeral) {
    tmpSessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
    args.push("--session-dir", tmpSessionDir);
  }

  const cleanup = (): void => {
    if (tmpSessionDir) {
      try {
        rmSync(tmpSessionDir, { recursive: true, force: true });
      } catch {
        // best-effort; throwaway temp dir.
      }
      tmpSessionDir = undefined;
    }
  };

  const invocation = resolvePiInvocation(args, opts.command);

  return new Promise<ForkProbeResult>((resolve) => {
    let proc: ChildProcess | undefined;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: opts.cwd ?? process.cwd(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      cleanup();
      resolve({ ok: false, answer: "", exitCode: null, stderr: "", errorMessage: `spawn failed: ${errmsg(err)}` });
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
      } catch {
        // already dead — ignore.
      }
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
        errorMessage: ok ? undefined : stderrText.trim() || `fork probe exited ${code}`,
      });
    });
    proc.on("error", (err) => {
      finish({ ok: false, answer: "", exitCode: null, stderr: stderrText.trim(), errorMessage: `spawn error: ${errmsg(err)}` });
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
          finish({ ok: false, answer: "", exitCode: null, stderr: stderrText.trim(), errorMessage: `stdin write failed: ${errmsg(err)}` }),
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

// ── forkGate: the 3-step pattern ─────────────────────────────────────────────

/**
 * The out-of-band fork-tool pattern, composed from `runForkProbe`:
 *   1. Fork       — `runForkProbe(opts, opts.prompt)` (child gets full history).
 *   2. Signal     — `opts.decide(answer)` → a signal, or null.
 *   3. Append     — on a non-null signal, `opts.onSignal(signal, answer)` (the
 *                   consumer appends to the original session); on null or a
 *                   failed probe, nothing — leave it be.
 *
 * Never rejects. A failed probe yields `ok:false, appended:false` so the
 * original session is left untouched by default.
 */
export async function forkGate<TSignal>(opts: ForkGateOptions<TSignal>): Promise<ForkGateOutcome<TSignal>> {
  assertc(typeof opts?.prompt === "string", "prompt required");
  assertc(typeof opts?.decide === "function", "decide required");
  assertc(typeof opts?.onSignal === "function", "onSignal required");

  const result = await runForkProbe(opts, opts.prompt);
  if (!result.ok) {
    return { ok: false, answer: result.answer, signal: null, appended: false, errorMessage: result.errorMessage };
  }
  const signal = opts.decide(result.answer);
  if (signal === null || signal === undefined) {
    return { ok: true, answer: result.answer, signal: null, appended: false };
  }
  opts.onSignal(signal, result.answer);
  return { ok: true, answer: result.answer, signal, appended: true };
}
