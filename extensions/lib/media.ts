/**
 * Media helpers for the `read` tool's media path. A file is media only when a
 * known media extension AND matching magic bytes agree (`.ts` is text unless
 * MPEG-TS). We mirror pi's detectSupportedImageMimeType exactly (utils/mime.ts
 * is not re-exported); pi-ai has no video type, so video returns a note.
 */

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";

const SNIFF_BYTES = 4100;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function startsWithAscii(
  buf: Uint8Array,
  offset: number,
  text: string,
): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] ?? 0) * 0x1000000 +
    ((buf[offset + 1] ?? 0) << 16) +
    ((buf[offset + 2] ?? 0) << 8) +
    (buf[offset + 3] ?? 0)
  );
}

function isAnimatedPng(buf: Uint8Array): boolean {
  let offset = PNG_SIG.length;
  while (offset + 8 <= buf.length) {
    const len = readUint32BE(buf, offset);
    const typeOffset = offset + 4;
    if (startsWithAscii(buf, typeOffset, "acTL")) return true;
    if (startsWithAscii(buf, typeOffset, "IDAT")) return false;
    const next = offset + 8 + len + 4;
    if (next <= offset || next > buf.length) return false;
    offset = next;
  }
  return false;
}

export function detectImageMimeType(buf: Uint8Array): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return buf[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buf, PNG_SIG)) {
    const isPng =
      buf.length >= 16 &&
      readUint32BE(buf, PNG_SIG.length) === 13 &&
      startsWithAscii(buf, 12, "IHDR");
    return isPng && !isAnimatedPng(buf) ? "image/png" : null;
  }
  if (startsWithAscii(buf, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "WEBP"))
    return "image/webp";
  return null;
}

/** MPEG-TS: the 0x47 sync byte repeats every 188 bytes; checking at 188/376 rules out text starting with 'G'. */
function isMpegTs(buf: Uint8Array): boolean {
  if (buf.length < 189 || buf[0] !== 0x47 || buf[188] !== 0x47) return false;
  return buf.length < 377 || buf[376] === 0x47;
}

function detectVideoMagic(buf: Uint8Array): boolean {
  if (isMpegTs(buf)) return true;
  if (startsWithAscii(buf, 4, "ftyp")) return true; // mp4, mov, m4v, 3gp, …
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return true; // webm, mkv (EBML)
  if (startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "AVI "))
    return true;
  if (startsWith(buf, [0x46, 0x4c, 0x56, 0x01])) return true;
  if (
    buf.length >= 4 &&
    buf[0] === 0 &&
    buf[1] === 0 &&
    buf[2] === 1 &&
    (buf[3] === 0xba || buf[3] === 0xb3)
  )
    return true; // mpeg program/elementary stream
  if (startsWith(buf, [0x30, 0x26, 0xb2, 0x75])) return true; // asf/wmv
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53, 0x00])) return true;
  return false;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "m4v",
  "mpg",
  "mpeg",
  "wmv",
  "flv",
  "3gp",
  "ts",
  "ogv",
]);

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot < 0 ? "" : filePath.slice(dot + 1).toLowerCase();
}

export type MediaKind =
  | { kind: "image"; mime: string }
  | { kind: "video" }
  | null;

export async function sniffMediaType(filePath: string): Promise<MediaKind> {
  const ext = extOf(filePath);
  const isImageExt = IMAGE_EXTENSIONS.has(ext);
  const isVideoExt = VIDEO_EXTENSIONS.has(ext);
  if (!isImageExt && !isVideoExt) return null;
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    const b = buf.subarray(0, bytesRead);
    if (isImageExt) {
      const img = detectImageMimeType(b);
      if (img) return { kind: "image", mime: img };
    } else if (isVideoExt) {
      if (detectVideoMagic(b)) return { kind: "video" };
    }
    return null;
  } finally {
    await handle.close();
  }
}

export function modelSupportsVision(model: Model<any> | undefined): boolean {
  return model?.input?.includes("image") ?? false;
}

export function resolveMediaPath(rawPath: string, cwd: string): string {
  let p = rawPath.trim();
  if (p.startsWith("~")) p = homedir() + p.slice(1);
  // Strip a leading `@` (some terminals paste file refs that way).
  if (p.startsWith("@")) p = p.slice(1);
  return resolvePath(cwd, p);
}

export function shortenPath(absolutePath: string): string {
  const home = homedir();
  if (home && absolutePath.startsWith(home))
    return `~${absolutePath.slice(home.length)}`;
  return absolutePath;
}

export function displayPath(absolutePath: string, cwd: string): string {
  if (absolutePath === cwd) return ".";
  if (absolutePath.startsWith(cwd + sep)) {
    return absolutePath.slice(cwd.length + sep.length);
  }
  return shortenPath(absolutePath);
}
