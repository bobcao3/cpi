/**
 * Media helpers for the read-media tool.
 *
 * pi's built-in `read` tool sniffs image magic bytes via `utils/mime.ts` and
 * renders via `core/tools/render-utils.ts`, but neither module is re-exported
 * by the public package (`exports` maps only `.`). We mirror the exact same
 * sniff logic here so read-media accepts precisely the image formats pi can
 * inline (jpg, png, gif, webp) — no more, no less — and reject animated PNG
 * the same way (pi declines to inline it).
 */

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";

const SNIFF_BYTES = 4100;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function startsWithAscii(buf: Uint8Array, offset: number, text: string): boolean {
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

/**
 * Returns the inline-image MIME type pi accepts, or null.
 * Mirrors pi's `detectSupportedImageMimeType` exactly.
 */
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
  if (startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "WEBP")) return "image/webp";
  return null;
}

/** Sniff the first bytes of a file for a supported inline image type. */
export async function detectImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return detectImageMimeType(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// pi-ai has no video content type (only TextContent | ImageContent) and the
// model registry exposes no video capability flag, so native video inline is
// impossible through pi today. We still detect video so the tool can return a
// clear, actionable note instead of silently sending garbage.
const VIDEO_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "avi", "mkv", "m4v", "mpg", "mpeg",
  "wmv", "flv", "3gp", "ts", "ogv",
]);

export function isVideoPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(filePath.slice(dot + 1).toLowerCase());
}

/** Expand ~ and resolve a media path relative to cwd. */
export function resolveMediaPath(rawPath: string, cwd: string): string {
  let p = rawPath.trim();
  if (p.startsWith("~")) p = homedir() + p.slice(1);
  // Strip a leading `@` (some terminals paste file refs that way).
  if (p.startsWith("@")) p = p.slice(1);
  return resolvePath(cwd, p);
}

/** Shorten an absolute path to ~ when inside the home dir, for display. */
export function shortenPath(absolutePath: string): string {
  const home = homedir();
  if (home && absolutePath.startsWith(home)) return `~${absolutePath.slice(home.length)}`;
  return absolutePath;
}

/** Build a display path: relative to cwd when inside it, else ~-shortened. */
export function displayPath(absolutePath: string, cwd: string): string {
  if (absolutePath === cwd) return ".";
  if (absolutePath.startsWith(cwd + sep)) {
    return absolutePath.slice(cwd.length + sep.length);
  }
  return shortenPath(absolutePath);
}
