import type { WriteStream } from "node:fs";
import type { StringDecoder } from "node:string_decoder";
import type { MonitorClient, ResumeClient } from "./monitor.ts";
import type { ShellDialect, ShellProfile } from "./profile.ts";
export interface BackgroundChild {
  id: string;
  activityId: string;
  startedAt: number;
  pid: number;
  command: string;
  dialect?: ShellDialect;
  describe?: string;
  client: MonitorClient | ResumeClient;
  logPath: string;
  acc: string;
  decoder: StringDecoder;
  exitCode: number | null;
  done: boolean;
  cancelRequested?: boolean;
  signaled?: boolean;
  bytesEmitted: number;
  linesEmitted: number;
  colBytes: number;
  sessDir?: string;
  sessScope?: string;
}
export type CompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "stopped" | "breach",
  log?: {
    path: string;
    startLine?: number;
    endLine?: number;
    activityId?: string;
    scope?: string;
  },
) => void;
export interface RepeatMonitor {
  id: string;
  command: string;
  shell: ShellProfile;
  sessScope?: string;
  describe?: string;
  intervalSec: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  running: boolean;
  breached: boolean;
  client?: MonitorClient;
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  nextTimer?: ReturnType<typeof setTimeout>;
  logPath: string;
  logStream: WriteStream;
  logLine: number;
  invocation: number;
  startLine?: number;
  observingChild?: boolean;
  stopSignal?: string;
  outputBytes?: number;
}
