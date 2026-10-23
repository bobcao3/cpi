import type { WriteStream } from "node:fs";
import type { StringDecoder } from "node:string_decoder";
import type { MonitorClient, ResumeClient } from "./monitor.ts";
import type { ShellDialect, ShellProfile } from "./profile.ts";
import type { ShellStorage } from "./storage.ts";
import type { SessionOwner } from "../lib/storage/owner.ts";
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
  storage?: ShellStorage;
  artifact_owner?: SessionOwner;
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
  owner?: import("../lib/storage/owner.ts").SessionOwner;
  operation?: import("../lib/storage/operations.ts").OwnedOperation;
  legacy?: boolean;
  storageBound?: boolean;
  completionSent?: boolean;
  lastExit?: number | null;
  notifyStopped?: () => void;
  task?: Promise<void>;
  launching?: Promise<import("./monitor.ts").MonitorHandle>;
  launchCleanup?: () => Promise<void>;
  nativeJoined?: boolean;
  reaping?: Promise<void>;
  logClosed?: Promise<void>;
  logError?: unknown;
  wake?: (code: number | null) => void;
  signalSent?: boolean;
  signalTask?: Promise<void>;
  abort?: () => void;
  settled?: () => void;
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
