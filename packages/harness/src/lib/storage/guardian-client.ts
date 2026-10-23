import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { toolPackage } from "../tool-package.ts";
import { sessionArtifactDirectory, type SessionOwner } from "./owner.ts";
import { read_guardian_record } from "./journal.ts";

interface Receipt {
  version: number;
  state: "ready" | "closed" | "pending" | "retained";
  path: string;
  record: string;
  error?: string;
}
interface Waiter {
  resolve(value: Receipt): void;
  reject(error: Error): void;
}
const REQUEST_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 32768;

export class ScratchGuardian {
  readonly path: string;
  readonly record: string;
  private readonly config: Record<string, unknown>;
  private child?: ChildProcessWithoutNullStreams;
  private started = false;
  private exit_code: number | null | undefined;
  private exited?: Promise<void>;
  private start_promise?: Promise<string>;
  private close_promise?: Promise<void>;
  private ready?: Receipt;
  private ready_waiter?: Waiter;
  private close_waiter?: Waiter;
  private buffer = Buffer.alloc(0);
  private diagnostics = "";
  private failure?: Error;

  constructor(
    owner: SessionOwner,
    purpose: string,
    id: string,
    retain: boolean,
  ) {
    if (!isMainThread)
      throw new Error(
        "scratch guardian requires a root host, not an untracked Worker",
      );
    if (process.platform !== "linux")
      throw new Error(
        "native scratch supervision requires Linux pidfd support",
      );
    const root = sessionArtifactDirectory(owner, purpose);
    const journal = sessionArtifactDirectory(owner, "storage-guardian");
    this.path = join(root, `${retain ? "retained" : "scratch"}-${id}`);
    this.record = join(journal, `${id}.json`);
    this.config = {
      version: 1,
      host_pid: process.pid,
      session_id: owner.session_id,
      session_dir: owner.session_dir,
      root,
      journal,
      id,
      retain,
    };
  }

  start(): Promise<string> {
    return (this.start_promise ??= this.launch());
  }
  private async launch(): Promise<string> {
    const registration = JSON.stringify(this.config) + "\n";
    if (Buffer.byteLength(registration) > 16384)
      throw new Error("oversized guardian registration");
    const { resolveGhostmux } = await toolPackage("@cpi/ghostmux/resolve");
    const binary = await resolveGhostmux();
    this.child = spawn(binary, ["--storage-guardian"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.started = this.child.pid !== undefined;
    const child = this.child;
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as typeof stream & { unref?(): void }).unref?.();
    this.exited = new Promise((resolve) =>
      child.once("close", (code) => {
        this.exit_code = code;
        this.fail(
          new Error(`scratch guardian exited (${code}): ${this.diagnostics}`),
        );
        resolve();
      }),
    );
    child.once("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString("utf8")).slice(
        -2048,
      );
    });
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    const ready = this.wait("ready");
    child.stdin.write(registration);
    await ready;
    return this.path;
  }
  private fail(error: Error): void {
    this.failure = error;
    this.ready_waiter?.reject(error);
    this.close_waiter?.reject(error);
  }
  private receive(chunk: Buffer): void {
    try {
      if (this.buffer.length + chunk.length > MAX_FRAME_BYTES * 2)
        throw new Error("oversized guardian response");
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (let frames = 0; frames < 4; frames++) {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) {
          if (this.buffer.length > MAX_FRAME_BYTES)
            throw new Error("oversized guardian frame");
          return;
        }
        if (newline > MAX_FRAME_BYTES)
          throw new Error("oversized guardian frame");
        const value = JSON.parse(
          this.buffer.subarray(0, newline).toString("utf8"),
        ) as Receipt;
        this.buffer = this.buffer.subarray(newline + 1);
        if (
          value.version !== 1 ||
          value.path !== this.path ||
          value.record !== this.record ||
          !["ready", "closed", "pending", "retained"].includes(value.state)
        )
          throw new Error("invalid guardian receipt");
        if (value.state === "ready") {
          if (this.ready) throw new Error("duplicate guardian grant");
          this.ready = value;
          this.ready_waiter?.resolve(value);
        } else {
          this.close_waiter?.resolve(value);
        }
        if (!this.buffer.length) return;
      }
      throw new Error("guardian response limit reached");
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private async wait(kind: "ready" | "close"): Promise<Receipt> {
    if (kind === "ready" && this.ready) return this.ready;
    if (this.failure) throw this.failure;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = kind === "ready" ? "ready_waiter" : "close_waiter";
    if (this[key]) throw new Error("concurrent guardian request");
    try {
      return await new Promise<Receipt>((resolve, reject) => {
        this[key] = { resolve, reject };
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `scratch guardian ${kind} timed out; outcome pending: ${this.record}`,
              ),
            ),
          REQUEST_TIMEOUT_MS,
        );
      });
    } finally {
      clearTimeout(timer);
      this[key] = undefined;
    }
  }
  close(): Promise<void> {
    return (this.close_promise ??= this.release().catch((error) => {
      this.close_promise = undefined;
      throw error;
    }));
  }
  private async release(): Promise<void> {
    if (!this.started) {
      if (!existsSync(this.path) && !existsSync(this.record)) return;
      throw new Error(`scratch allocation outcome pending: ${this.record}`);
    }
    if (this.exit_code !== undefined) {
      if (existsSync(this.record)) {
        const value = await read_guardian_record(this.record);
        if (
          value.path === this.path &&
          (value.state !== "closed" || !existsSync(this.path)) &&
          ["closed", "retained"].includes(value.state)
        )
          return;
      }
      if (!existsSync(this.path) && !existsSync(this.record)) return;
      throw new Error(
        `scratch guardian unavailable; cleanup pending: ${this.record}`,
      );
    }
    const receipt = this.wait("close");
    this.child!.stdin.write('{"command":"close"}\n');
    const result = await receipt;
    if (result.state === "pending")
      throw new Error(
        `scratch cleanup pending at ${this.path}: ${result.error ?? this.record}`,
      );
    if (result.state !== "closed" && result.state !== "retained")
      throw new Error("invalid scratch closure receipt");
    this.child!.stdin.end();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(`scratch guardian exit pending: ${this.record}`),
              ),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
