/**
 * sh-monitor wire protocol: a type-tagged, length-prefixed binary framing with
 * a typebox-defined control-message schema. Pure data — no pi/net imports
 * beyond the Socket type.
 *
 * Frame layout (uniform, bounded):
 *   [type:1][len:uint32 BE][payload:len]   assert len <= MAX_FRAME
 *
 *   0x01 CONTROL  payload = UTF-8 JSON `Message`        (low-volume, debuggable)
 *   0x02 DATA     payload = [off:uint64 BE][child bytes]   zero-copy byte stream
 *
 * The data plane (child stdout/stderr) rides raw DATA frames — no base64, no
 * encode/decode cost. The control plane is JSON, validated against the typebox
 * `Message` schema at the read boundary. One schema definition is the single
 * source of truth for the TS type, the JSON schema, and the runtime validator.
 *
 * DATA frame contract: a `buf` delivered to `onData` is a subarray of the
 * reader's internal buffer and is valid only for the duration of the callback.
 * Consume it synchronously, or copy (`Buffer.from(buf)`) to retain it.
 */

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";


export const FRAME_CONTROL = 0x01;
export const FRAME_DATA = 0x02;
export const MAX_FRAME = 4 * 1024 * 1024; // 4 MiB hard cap — explicit limit

const uint64 = Type.Integer({ minimum: 0 });

// ── control-message schema (discriminated union on `kind`) ──────────────────

const StatReq = Type.Object({ kind: Type.Literal("stat") });
const SignalReq = Type.Object({ kind: Type.Literal("signal"), sig: Type.String() });
const SubscribeReq = Type.Object({ kind: Type.Literal("subscribe") });
const ShutdownReq = Type.Object({ kind: Type.Literal("shutdown") });
const BindResumeReq = Type.Object({ kind: Type.Literal("bindResume") });
const StatusMsg = Type.Object({
  kind: Type.Literal("status"),
  pid: Type.Integer(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  bytes: uint64,
  lines: uint64,
  logPath: Type.String(),
});
const SubscribedMsg = Type.Object({ kind: Type.Literal("subscribed"), offset: uint64 });
const ResumeReadyMsg = Type.Object({ kind: Type.Literal("resumeReady"), sockPath: Type.String() });
const OkMsg = Type.Object({ kind: Type.Literal("ok") });
const ErrMsg = Type.Object({ kind: Type.Literal("err"), message: Type.String() });
const ExitMsg = Type.Object({ kind: Type.Literal("exit"), exitCode: Type.Integer(), bytes: uint64 });

export const Message = Type.Union([
  StatReq,
  SignalReq,
  SubscribeReq,
  ShutdownReq,
  BindResumeReq,
  StatusMsg,
  SubscribedMsg,
  ResumeReadyMsg,
  OkMsg,
  ErrMsg,
  ExitMsg,
]);
export type Message = Static<typeof Message>;
export type StatusMsg = Static<typeof StatusMsg>;
export type SubscribedMsg = Static<typeof SubscribedMsg>;
export type ResumeReadyMsg = Static<typeof ResumeReadyMsg>;
export type OkMsg = Static<typeof OkMsg>;
export type ErrMsg = Static<typeof ErrMsg>;
export type ExitMsg = Static<typeof ExitMsg>;

export type Request = Extract<Message, { kind: "stat" | "signal" | "subscribe" | "shutdown" | "bindResume" }>;

export function isMessage(msg: unknown): msg is Message {
  return Value.Check(Message, msg);
}

// ── writers ──────────────────────────────────────────────────────────────────

export function writeControl(sock: NodeJS.WritableStream, msg: Message): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_FRAME) throw new Error(`control frame too large: ${body.length}`);
  const hdr = Buffer.allocUnsafe(5);
  hdr.writeUInt8(FRAME_CONTROL, 0);
  hdr.writeUInt32BE(body.length, 1);
  sock.write(hdr);
  sock.write(body);
}

/** Zero-copy: writes the 13-byte header, then the child buffer itself. */
export function writeData(sock: NodeJS.WritableStream, off: number, buf: Buffer): boolean {
  const payloadLen = 8 + buf.length;
  if (payloadLen > MAX_FRAME) throw new Error(`data frame too large: ${payloadLen}`);
  const hdr = Buffer.allocUnsafe(13);
  hdr.writeUInt8(FRAME_DATA, 0);
  hdr.writeUInt32BE(payloadLen, 1);
  hdr.writeBigUInt64BE(BigInt(off), 5);
  sock.write(hdr);
  if (buf.length) return sock.write(buf);
  return true;
}

// ── reader ───────────────────────────────────────────────────────────────────

export interface FrameHandlers {
  onControl(msg: Message): void;
  onData(off: number, buf: Buffer): void;
  /** Protocol violation on this socket — caller should close it. */
  onFrameError(reason: string): void;
}

const READER_INIT_CAP = 65536;

/** Streaming frame parser. Buffers partial frames; never copies data bytes. */
export class FrameReader {
  private h: FrameHandlers;
  private buf: Buffer;
  private start = 0; // first unconsumed byte
  private end = 0; // one past last buffered byte
  constructor(h: FrameHandlers) {
    this.h = h;
    this.buf = Buffer.allocUnsafe(READER_INIT_CAP);
  }

  feed(chunk: Buffer): void {
    if (chunk.length > MAX_FRAME) {
      this.h.onFrameError(`chunk too large: ${chunk.length}`);
      return;
    }
    this.ensure(chunk.length);
    chunk.copy(this.buf, this.end);
    this.end += chunk.length;
    this.pump();
  }

  private ensure(need: number): void {
    if (this.start > 0) {
      this.buf.copy(this.buf, 0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
    }
    if (this.end + need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.end + need) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.buf.copy(nb, 0, 0, this.end);
    this.buf = nb;
  }

  private pump(): void {
    while (true) {
      const avail = this.end - this.start;
      if (avail < 5) return;
      const type = this.buf[this.start];
      const len = this.buf.readUInt32BE(this.start + 1);
      if (len > MAX_FRAME) {
        this.h.onFrameError(`frame too large: ${len}`);
        return;
      }
      if (avail < 5 + len) return; // wait for the rest of the payload
      const payload = this.buf.subarray(this.start + 5, this.start + 5 + len);
      this.start += 5 + len;
      if (type === FRAME_CONTROL) {
        let msg: unknown;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch {
          this.h.onFrameError("malformed control frame");
          return;
        }
        if (!isMessage(msg)) {
          this.h.onFrameError("schema-invalid control frame");
          return;
        }
        this.h.onControl(msg);
      } else if (type === FRAME_DATA) {
        if (payload.length < 8) {
          this.h.onFrameError("data frame too short");
          return;
        }
        const off = Number(payload.readBigUInt64BE(0));
        this.h.onData(off, payload.subarray(8)); // zero-copy subarray; see contract
      }
      // unknown frame types: skip (forward-compatible)
    }
  }
}
