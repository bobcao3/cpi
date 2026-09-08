import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import type { StringDecoder } from "node:string_decoder";
import type { MonitorClient, ResumeClient } from "./monitor.ts";
import type { ShellProfile } from "./profile.ts";
export interface BackgroundChild {
  id: string;
  activityId: string;
  startedAt: number;
  pid: number;
  command: string;
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
  log?: { path: string; startLine?: number; endLine?: number },
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
  child?: ChildProcess;
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  nextTimer?: ReturnType<typeof setTimeout>;
  logPath: string;
  logStream: WriteStream;
  logLine: number;
  invocation: number;
  startLine?: number;
  observingChild?: boolean;
  outputBytes?: number;
}
