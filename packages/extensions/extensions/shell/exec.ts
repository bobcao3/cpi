import { randomUUID } from "node:crypto";
export {
  captureSessionScreenshot,
  getSessionTarget,
  ghostmuxRpc,
  resolveGhostmuxBinary,
} from "./ghostmux.ts";
import { setTargetScope } from "./ghostmux.ts";
import { StringDecoder } from "node:string_decoder";
import {
  buildOutputText,
  accumulateOutput,
  type ShellTunables,
  type ShResult,
  type OutputTruncation,
} from "./output.ts";
export { buildOutputText } from "./output.ts";
export type {
  ShellTunables,
  ShResult,
  OutputCursor,
  OutputTruncation,
} from "./output.ts";
import {
  getActiveRepeats,
  hasActiveRepeats,
  setRepeatCompletionHook,
  setRepeatScopeGetter,
  signalRepeat,
} from "./repeat.ts";
import { launchMonitor, type MonitorClient } from "./monitor.ts";
import {
  recordShellStart,
  recordShellEnd,
  updateShellRecord,
} from "./persistence.ts";
import {
  shellState,
  completeBackground,
  stopBackground,
} from "./background-lifecycle.ts";
export { killAll, resumeBackgroundShells } from "./background-lifecycle.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";
import {
  updateActivity,
  finishActivity,
  setActivitySession,
} from "../lib/activity.ts";
import { observeShell, finishShell } from "./activity.ts";
import type { BackgroundChild, CompletionHook } from "./background-types.ts";
export type { CompletionHook } from "./background-types.ts";

const bg = shellState.backgrounds;
export const setCurrentScope = (scope: string | undefined): void => {
  shellState.scope = scope;
  setTargetScope(scope);
  setActivitySession(scope);
};
setRepeatScopeGetter(() => shellState.scope);
export const setCompletionHook = (fn: CompletionHook) => {
  shellState.completionHook = fn;
  setRepeatCompletionHook(fn);
};

export async function runShell(
  command: string,
  waitforSec: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onPartial: ((t: string) => void) | undefined,
  describe: string | undefined,
  maxWaitfor: number,
  truncation: OutputTruncation,
  tunables: ShellTunables,
  shell: ShellProfile = resolveShell("bash"),
  cwd: string = process.cwd(),
  isPty = false,
): Promise<ShResult> {
  if (signal?.aborted)
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: "Aborted before start.",
    };
  const activityId = randomUUID();
  const sessDir = env.PI_SESSION_DIR;
  const sessScope = env.PI_SESSION_ID;
  let handle: Awaited<ReturnType<typeof launchMonitor>>;
  try {
    handle = await launchMonitor(
      command,
      env,
      activityId,
      shell,
      cwd,
      isPty,
      signal,
    );
  } catch (e) {
    return {
      id: null,
      status: "completed",
      exitCode: signal?.aborted ? 137 : -1,
      text: `ghostmux launch failed: ${(e as Error).message}`,
    };
  }
  const { client, logPath } = handle;

  let status: Awaited<ReturnType<MonitorClient["stat"]>>;
  try {
    status = await client.stat();
  } catch (e) {
    await client.reap().catch(() => {});
    client.close();
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: `ghostmux stat failed: ${(e as Error).message}`,
    };
  }
  const pid = status.pid;
  const id = String(pid);

  const decoder = new StringDecoder("utf8");
  let exitCode: number | null = null;
  let lastUpd = 0;
  const entry: BackgroundChild = {
    id,
    activityId,
    startedAt: Date.now(),
    pid,
    command,
    dialect: shell.dialect ?? undefined,
    describe,
    client,
    logPath,
    sessDir,
    sessScope,
    acc: "",
    decoder,
    exitCode: null,
    done: false,
    bytesEmitted: 0,
    linesEmitted: 0,
    colBytes: 0,
  };
  observeShell(entry, cwd);
  try {
    recordShellStart(entry, cwd);
  } catch (e) {
    finishActivity(entry.activityId, "failed");
    await client.reap();
    client.close();
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: `ghostmux persistence start failed: ${(e as Error).message}`,
    };
  }

  let exitResolve!: () => void;
  const exitP = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const onEvent = (
    ev:
      | { kind: "data"; off: number; buf: Buffer }
      | { kind: "exit"; exitCode: number; bytes: number },
  ) => {
    if (ev.kind === "data") {
      accumulateOutput(entry, ev.buf, ev.off, tunables.maxAcc);
      updateActivity(entry.activityId, {
        metrics: {
          output_bytes: entry.bytesEmitted,
          last_output_at: Date.now(),
        },
      });
      const now = Date.now();
      if (onPartial && now - lastUpd >= tunables.updateMs) {
        lastUpd = now;
        void buildOutputText(entry.acc, {
          persistIfTruncated: false,
          truncation,
          tunables,
        }).then((r) => onPartial(r.text));
      }
    } else {
      finishShell(entry, ev.exitCode, ev.bytes);
      if (entry.done) return;
      entry.acc += entry.decoder.end();
      exitCode = ev.exitCode;
      completeBackground(entry, ev.exitCode);
      exitResolve();
    }
  };
  try {
    await client.subscribe(onEvent);
  } catch (e) {
    if (!entry.done) {
      finishActivity(entry.activityId, "failed", { connection_lost: 1 });
      recordShellEnd(entry, "lost", -1, true);
      await client.reap().catch(() => {});
      client.close();
      return {
        id: null,
        status: "completed",
        exitCode: -1,
        text: `ghostmux subscribe failed: ${(e as Error).message}`,
      };
    }
  }
  const onSockClose = () => {
    if (!stopBackground(entry)) return;
    exitCode = -1;
    exitResolve();
  };
  client.onClose(onSockClose);

  const onAbort = () => client.sendSignal("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  let timer: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([
    exitP.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(
        () => r(false),
        Math.min(waitforSec, maxWaitfor) * 1000,
      );
    }),
  ]);
  signal?.removeEventListener("abort", onAbort);
  clearTimeout(timer!);

  if (completed) {
    client.close();
    const content = entry.acc;
    const outputLines = entry.linesEmitted + (entry.colBytes > 0 ? 1 : 0);
    if (content) updateActivity(entry.activityId, { tail: content });
    const { text } = await buildOutputText(content, {
      logPath,
      truncation,
      tunables,
    });

    return {
      id,
      ...client.target,
      status: "completed",
      exitCode,
      backendError: client.target?.error,
      text: client.target?.error
        ? `ghostmux: ${client.target.error}\n${text}`
        : text,
      outputLines,
      fullOutputPath: logPath,
    };
  }
  // still running → background it; the subscribe callback stays live for completion
  bg.set(id, entry);
  const { text } = await buildOutputText(entry.acc, {
    logPath,
    truncation,
    tunables,
  });
  return {
    id,
    ...client.target,
    status: "running",
    exitCode: null,
    text,
    fullOutputPath: logPath,
    cursor: {
      line: entry.linesEmitted + 1,
      column: entry.colBytes,
      bytes: entry.bytesEmitted,
    },
  };
}

export function signalChild(id: string, sig: string): boolean {
  if (id.startsWith("rpt-")) return signalRepeat(id, sig);
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== shellState.scope) return false;
  if (
    process.platform === "win32" ||
    ["SIGINT", "SIGTERM", "SIGKILL", "2", "15", "9"].includes(sig)
  ) {
    e.cancelRequested = true;
    updateActivity(e.activityId, { status: "stopping" });
  }
  e.client.sendSignal(sig);
  if (e.cancelRequested) {
    updateShellRecord(e.activityId, { cancelRequested: true });
  }
  return true;
}

export const silenceChild = (id: string): boolean => {
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== shellState.scope) return false;
  e.signaled = true;
  updateShellRecord(e.activityId, { noticeSuppressed: true });
  return true;
};

/**
 * Release a background PID to run on its own: disconnect without signalling,
 * no completion notification, killAll/session-shutdown won't touch it. Orphan
 * pi's pipe handles so its libuv loop can idle and `pi --print` can exit.
 * Returns the log path, or null if the id is not active.
 */
export const detachChild = (id: string): string | null => {
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== shellState.scope) return null;
  e.signaled = true; // suppress any in-flight completion hook
  finishActivity(e.activityId, "detached");
  recordShellEnd(e, "detached", undefined, true);
  e.client.orphan();
  bg.delete(id);
  return e.logPath;
};

export const getBackgroundCount = (): number =>
  [...bg.values()].filter((e) => e.sessScope === shellState.scope).length;
export const hasActiveBackground = (): boolean =>
  [...bg.values()].some((e) => !e.done && e.sessScope === shellState.scope) ||
  hasActiveRepeats();

export const getShellBackgrounds = () =>
  [...bg.values()]
    .filter((e) => e.sessScope === shellState.scope)
    .map((e) => ({
      id: e.id,
      describe: e.describe,
      uid: e.client.target?.uid,
      socketPath: e.client.target?.socketPath,
      isPty: e.client.target?.isPty,
    }));

export const getActiveBackgrounds = () => [
  ...[...bg.values()]
    .filter((e) => e.sessScope === shellState.scope)
    .map((e) => ({
      id: e.id,
      describe: e.describe,
      uid: e.client.target?.uid,
      socketPath: e.client.target?.socketPath,
      isPty: e.client.target?.isPty,
    })),
  ...getActiveRepeats(),
];
