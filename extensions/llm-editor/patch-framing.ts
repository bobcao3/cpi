import { resolve } from "node:path";

export interface PatchTarget {
  cwd: string;
  path: string;
}

export type PatchFramingError = "bad_framing" | "bad_target";

type FramingResult =
  | { ok: true; start: number; end: number }
  | { ok: false; code: PatchFramingError; line: number };

const OPEN =
  /^(?:\*\*\* Begin Patch|```(?:diff|patch)?|~~~(?:diff|patch)?)[ \t]*$/;
const CLOSE = /^(?:\*\*\* End(?: Patch| of patch)|```|~~~)[ \t]*$/;
const FILE_PAIR = /^--- (.*)$/;
const GIT_PAIR = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/;

function decode_path(raw: string): string | undefined {
  if (!raw.startsWith('"')) return raw;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (!quoted) return undefined;
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  const chunks: Buffer[] = [];
  const body = quoted[1];
  for (let index = 0; index < body.length; ) {
    if (body[index] !== "\\") {
      const next = body.indexOf("\\", index);
      const end = next < 0 ? body.length : next;
      chunks.push(Buffer.from(body.slice(index, end)));
      index = end;
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(index + 1, index + 4));
    const byte = octal ? parseInt(octal[0], 8) : escapes[body[index + 1]];
    if (byte === undefined) return undefined;
    chunks.push(Buffer.from([byte]));
    index += octal ? 4 : 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return undefined;
  }
}

function matches_target(
  path: string | undefined,
  target?: PatchTarget,
): boolean {
  return (
    !!target &&
    !!path &&
    path !== "/dev/null" &&
    !path.includes("\0") &&
    resolve(target.cwd, path) === resolve(target.cwd, target.path)
  );
}

function matches_pair(
  before: string,
  after: string,
  target?: PatchTarget,
): boolean {
  let source = decode_path(before);
  let destination = decode_path(after);
  if (source?.startsWith("a/") && destination?.startsWith("b/")) {
    source = source.slice(2);
    destination = destination.slice(2);
  }
  return matches_target(source, target) && matches_target(destination, target);
}

export function patch_framing(
  lines: string[],
  target?: PatchTarget,
): FramingResult {
  let start = 0;
  let end = lines.length;
  const bad = (code: PatchFramingError, at: number): FramingResult => ({
    ok: false,
    code,
    line: at + 1,
  });
  while (start < end && (lines[start].trim() === "" || OPEN.test(lines[start])))
    start++;
  for (let tail = end; tail > start; tail--) {
    if (CLOSE.test(lines[tail - 1])) end = tail - 1;
    else if (lines[tail - 1].trim() !== "") break;
  }
  let declaration = "";
  while (
    start < end &&
    !lines[start].startsWith("@@") &&
    lines[start] !== "***"
  ) {
    const line = lines[start];
    const git_body = line.startsWith("diff --git ") ? line.slice(11) : "";
    const middle = (git_body.length - 1) / 2;
    const git =
      GIT_PAIR.exec(line) ??
      (Number.isInteger(middle) && git_body[middle] === " "
        ? [line, git_body.slice(0, middle), git_body.slice(middle + 1)]
        : null);
    const pair = FILE_PAIR.exec(line);
    const update = /^\*\*\* Update File: (.+)$/.exec(line);
    if (git && declaration === "") {
      if (!matches_pair(git[1], git[2], target))
        return bad("bad_target", start);
      declaration = "git";
    } else if (pair && (declaration === "" || declaration === "git")) {
      const after = /^\+\+\+ (.*)$/.exec(lines[start + 1] ?? "");
      if (
        !after ||
        !matches_pair(
          pair[1].split("\t", 1)[0],
          after[1].split("\t", 1)[0],
          target,
        )
      )
        return bad("bad_target", start);
      declaration = "pair";
      start++;
    } else if (update && declaration === "") {
      if (!matches_target(decode_path(update[1]), target))
        return bad("bad_target", start);
      declaration = "update";
    } else if (
      !(
        declaration === "git" &&
        /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(line)
      )
    ) {
      return bad("bad_framing", start);
    }
    start++;
  }
  for (let index = start; index < end; index++) {
    const line = lines[index];
    if (
      /^(?:\*\*\* |diff --git |```|~~~)/.test(line) ||
      (FILE_PAIR.test(line) && /^\+\+\+ /.test(lines[index + 1] ?? ""))
    )
      return bad("bad_framing", index);
  }
  return { ok: true, start, end };
}
