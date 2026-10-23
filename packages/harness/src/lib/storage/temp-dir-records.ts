import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export interface DirectoryIdentity {
  dev: string;
  ino: string;
  birthtime_ns: string;
}

export function directory_identity(stat: BigIntStats): DirectoryIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
  };
}

export function same_identity(
  stat: BigIntStats,
  expected: DirectoryIdentity,
): boolean {
  return (
    String(stat.dev) === expected.dev &&
    String(stat.ino) === expected.ino &&
    String(stat.birthtimeNs) === expected.birthtime_ns
  );
}

export function private_directory(
  path: string,
  require_private = true,
): BigIntStats {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes("\0"))
    throw new Error(`noncanonical directory: ${path}`);
  let current = parse(path).root;
  const parts = relative(current, path).split(sep).filter(Boolean);
  if (parts.length > 128) throw new Error("directory depth limit reached");
  for (let index = 0; index <= parts.length; index++) {
    const stat = lstatSync(current, { bigint: true });
    const uid = process.getuid?.();
    const mode = Number(stat.mode);
    const leaf = index === parts.length;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (uid !== undefined &&
        stat.uid !== BigInt(uid) &&
        (leaf || stat.uid !== 0n)) ||
      (process.platform !== "win32" &&
        (leaf && require_private
          ? (mode & 0o077) !== 0
          : (mode & 0o022) !== 0 &&
            !(stat.uid === 0n && (mode & 0o1000) !== 0)))
    )
      throw new Error(`unsafe directory or parent: ${current}`);
    if (leaf) return stat;
    current = join(current, parts[index]!);
  }
  throw new Error("directory validation incomplete");
}

export function read_private_record(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size > 16384n ||
      (process.getuid && stat.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (Number(stat.mode) & 0o077) !== 0)
    )
      throw new Error(`unsafe directory metadata: ${path}`);
    const buffer = Buffer.alloc(16385);
    let length = 0;
    for (let reads = 0; reads < buffer.length; reads++) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      length += count;
      if (!count) break;
      if (length === buffer.length)
        throw new Error("directory metadata size limit reached");
    }
    if (
      !same_identity(
        lstatSync(path, { bigint: true }),
        directory_identity(stat),
      )
    )
      throw new Error(`directory metadata changed during read: ${path}`);
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export function write_private_record(path: string, value: unknown): void {
  const data = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(data) > 16384)
    throw new Error("directory metadata size limit reached");
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  sync_private_directory(dirname(path));
}

export function sync_private_directory(path: string): void {
  const expected = directory_identity(private_directory(path));
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!same_identity(fstatSync(fd, { bigint: true }), expected))
      throw new Error(`directory changed during metadata sync: ${path}`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reject_nested_mounts(path: string): void {
  if (process.platform !== "linux") return;
  const entries = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  if (entries.length > 16384) throw new Error("mount inventory limit reached");
  for (const entry of entries) {
    const field = entry.split(" ", 6)[4];
    if (!field) continue;
    const mounted = field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (mounted === path || mounted.startsWith(path + sep))
      throw new Error(
        `refusing to release a mounted directory tree: ${mounted}`,
      );
  }
}
