/**
 * backup-exec — dead-simple argv runner for cpi development.
 *
 * Codex `exec` argv semantics: `command` is an argv vector exec'd directly
 * with no shell (`spawn(argv[0], argv.slice(1))`). Optional `workdir` and
 * `timeout_ms`. If `command` is omitted/empty it defaults to `[$SHELL]`
 * (argv[0] = $SHELL). Returns combined stdout+stderr and the exit code.
 *
 * Dev-only — NOT part of the shipped cpi package:
 *   - Registered as a single extension FILE via ~/cpi/.pi/settings.json
 *     (project scope), so it loads only when pi runs inside the cpi repo.
 *   - The cpi package manifest (`pi.extensions: ["./extensions"]`) never
 *     sweeps .pi/, and .pi/ is absent from the npm `files` set, so
 *     `pi install npm:cpi` / `pi install -l .` consumers never see this tool.
 *
 * Guideline (see text/backup-exec.toml): use ONLY when the `sh` tool
 * malfunctions (e.g. while mutating the shell extension). Prefer `sh`.
 *
 * Activation mirrors cwd.ts/alarm.ts: `registerTool` is an idempotent Map.set
 * on the fresh per-instance map (registered unconditionally at load), and the
 * tool is added to the active set on `session_start` / `resources_discover`
 * (re-merged per call — no globalThis dedup flag).
 */

import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadText,
  render,
  renderLines,
  textPath,
  type ToolText,
} from "../extensions/lib/text.ts";

const TOOL = "backup-exec";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

interface BackupExecText extends ToolText {
  schema: { command: string; workdir: string; timeout_ms: string };
}

/** Result returned to pi; `isError` marks tool-level failures. */
interface ExecResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function ensureActive(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  active.add(TOOL);
  pi.setActiveTools(Array.from(active));
}

export default function (pi: ExtensionAPI): void {
  const T = loadText<BackupExecText>("backup-exec", textPath("backup-exec"));
  const guidelines = renderLines(T.guidelines.bullets, {});

  const schema = Type.Object({
    command: Type.Optional(
      Type.Array(Type.String(), { description: T.schema.command }),
    ),
    workdir: Type.Optional(Type.String({ description: T.schema.workdir })),
    timeout_ms: Type.Optional(Type.Number({ description: T.schema.timeout_ms })),
  });

  pi.registerTool({
    name: TOOL,
    label: "backup-exec",
    description: render(T.tool.description, {}),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
    parameters: schema,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted)
        return {
          content: [{ type: "text", text: "Aborted before start." }],
          details: { aborted: true },
          isError: true,
        } satisfies ExecResult;

      // argv vector (Codex exec); default argv[0] = $SHELL when omitted/empty.
      const argv =
        Array.isArray(params.command) && params.command.length > 0
          ? params.command.map(String)
          : [process.env.SHELL || "/bin/sh"];
      const workdir =
        typeof params.workdir === "string" && params.workdir.trim()
          ? params.workdir
          : process.cwd();
      const requested =
        typeof params.timeout_ms === "number" && params.timeout_ms > 0
          ? params.timeout_ms
          : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const child = spawn(argv[0], argv.slice(1), {
        cwd: workdir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let acc = "";
      let truncated = false;
      const onChunk = (buf: Buffer): void => {
        if (truncated) return;
        acc += buf.toString("utf8");
        if (Buffer.byteLength(acc) > MAX_OUTPUT_BYTES) truncated = true;
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, timeoutMs);

      const onAbort = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      return new Promise<ExecResult>((resolve) => {
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({
            content: [{ type: "text", text: `exec error: ${err.message}` }],
            details: { argv, workdir, exitCode: null },
            isError: true,
          });
        });
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const aborted = signal?.aborted === true;
          let text = acc || "(no output)";
          if (truncated) text += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
          if (timedOut) text += `\n[timed out after ${timeoutMs}ms; killed]`;
          if (aborted) text += "\n[aborted]";
          const sigNote = sig ? ` (signal ${sig})` : "";
          resolve({
            content: [
              { type: "text", text: `exit ${code ?? -1}${sigNote}\n${text}` },
            ],
            details: {
              argv,
              workdir,
              exitCode: code,
              timedOut,
              aborted,
              signal: sig ?? null,
            },
            isError: timedOut || aborted,
          });
        });
      });
    },
  });

  pi.on("session_start", async () => ensureActive(pi));
  pi.on("resources_discover", async () => ensureActive(pi));
}
