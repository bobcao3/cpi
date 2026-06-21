/**
 * `sh_env_capture` — sole owner.
 *
 * Captures the current process environment (optionally after running a bash
 * command such as sourcing a venv) into a session-scoped dotenv file, then
 * reloadable via `env=<path>` on `sh` / `sh_repeat_until` (and, in a later
 * layer, `lsp`). Env contents are written to a file and referenced by path;
 * they are NEVER echoed into the conversation, so no redaction is needed.
 *
 * Registers the tool unconditionally at load. `pi.registerTool` is an
 * idempotent `Map.set` on the fresh per-instance map (AGENTS.md), so no
 * `globalThis` dedup flag is used — this extension is the sole owner.
 *
 * Explicit limits (TigerStyle): 30s capture timeout, 2 MiB stdout cap, 4096
 * keys, 32 KiB value truncation on write.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildShellEnv } from "./shell/tools.ts";
import { DOTENV_MAX_KEYS, DOTENV_MAX_VALUE_BYTES } from "./lib/dotenv.ts";

const CAPTURE_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 2 * 1024 * 1024; // 2 MiB — env output is normally a few KB
const MAX_KEYS = DOTENV_MAX_KEYS; // 4096 — shared with the parse side
const MAX_VALUE_BYTES = DOTENV_MAX_VALUE_BYTES; // 32 KiB
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface CaptureResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  overflow: boolean;
  spawnError?: string;
}

const errReturn = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function shortSha(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/** Sanitize a label into a safe filename fragment, or "" if none/empty. */
function sanitizeLabel(label: string | undefined): string {
  if (!label) return "";
  return label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

/** Serialize `env` stdout into `KEY=VALUE\n` lines with write-side limits. */
function serializeEnv(stdout: string): { body: string; count: number } {
  const out: string[] = [];
  let count = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!KEY_RE.test(key)) continue;
    let val = line.slice(eq + 1);
    if (Buffer.byteLength(val, "utf8") > MAX_VALUE_BYTES) {
      val = Buffer.from(val, "utf8").subarray(0, MAX_VALUE_BYTES).toString("utf8");
    }
    out.push(`${key}=${val}`);
    count++;
    if (count >= MAX_KEYS) break;
  }
  return { body: out.length ? out.join("\n") + "\n" : "", count };
}

async function writeCapture(
  body: string,
  label: string | undefined,
  command: string | undefined,
  sessionManager: { getSessionDir(): string | undefined } | undefined,
): Promise<string> {
  const sessionDir = sessionManager?.getSessionDir();
  // Ephemeral (--no-session) parents report "" → fall back to the agent dir.
  const dir = sessionDir ? join(sessionDir, "env-captures") : join(getAgentDir(), "env-captures");
  const name = `${sanitizeLabel(label) || shortSha(command || "env-snapshot")}.env`;
  const filePath = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, body, "utf8");
  return filePath;
}

function runCapture(
  command: string | undefined,
  baseEnv: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = command
        ? spawn("bash", ["-lc", `${command} && env`], { env: baseEnv })
        : spawn("env", [], { env: baseEnv });
    } catch (err) {
      resolve({
        stdout: "",
        exitCode: null,
        timedOut: false,
        overflow: false,
        spawnError: (err as Error).message,
      });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (r: CaptureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {}
      resolve(r);
    };
    const onAbort = () => finish({ stdout: "", exitCode: null, timedOut: true, overflow: false });
    const timer = setTimeout(
      () => finish({ stdout: "", exitCode: null, timedOut: true, overflow: false }),
      CAPTURE_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => {
      if (settled) return;
      chunks.push(c);
      bytes += c.length;
      if (bytes > STDOUT_CAP)
        finish({ stdout: "", exitCode: null, timedOut: false, overflow: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      finish({
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
        timedOut: false,
        overflow: false,
      });
    });
    child.on("error", (err) =>
      finish({
        stdout: "",
        exitCode: null,
        timedOut: false,
        overflow: false,
        spawnError: err.message,
      }),
    );
  });
}

export default async function envCaptureExtension(pi: ExtensionAPI): Promise<void> {
  pi.registerTool({
    name: "sh_env_capture",
    label: "sh_env_capture",
    description:
      "Capture the current process environment (optionally after running a bash command such as sourcing a venv) into a session-scoped dotenv file, reloadable via `env=<path>` on sh / sh_repeat_until / lsp.",
    promptSnippet: "Capture env into a dotenv file",
    promptGuidelines: [
      "Use sh_env_capture to snapshot env (e.g. after `source .venv/bin/activate`) into a file, then reload it via `env=<path>` on sh or sh_repeat_until.",
      "The returned `env=<path>` snippet is reusable across later commands; the file path is absolute and session-scoped.",
      "Reload the same captured file via `env=<path>` on sh / sh_repeat_until / `lsp start`.",
    ],
    parameters: Type.Object({
      command: Type.Optional(
        Type.String({
          description:
            "Optional bash to run before capturing (e.g. 'source .venv/bin/activate'). Omit = capture current process env.",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Optional name for the dotenv file" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = params.command?.trim() || undefined;
      const label = params.label?.trim() || undefined;
      const baseEnv = buildShellEnv(ctx?.sessionManager);
      const res = await runCapture(command, baseEnv, signal);
      if (res.spawnError) return errReturn(`sh_env_capture: failed to spawn: ${res.spawnError}`);
      if (res.timedOut)
        return errReturn(`sh_env_capture: timed out after ${CAPTURE_TIMEOUT_MS / 1000}s`);
      if (res.overflow)
        return errReturn(`sh_env_capture: env output exceeded ${STDOUT_CAP} bytes; aborted`);
      if (res.exitCode !== 0)
        return errReturn(
          `sh_env_capture: command failed (exit ${res.exitCode ?? "unknown"}); no env file written. Re-run the command via sh to inspect its output.`,
        );
      const { body, count } = serializeEnv(res.stdout);
      if (count === 0) return errReturn("sh_env_capture: no KEY=VALUE lines captured");
      const filePath = await writeCapture(body, label, command, ctx?.sessionManager);
      const text = `Captured ${count} env var${count !== 1 ? "s" : ""} → ${filePath}\nReload via: env=${filePath}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { path: filePath, count },
      };
    },
  });
}
