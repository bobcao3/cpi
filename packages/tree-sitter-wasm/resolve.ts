import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parsePubKey, parseSig, verifyMinisign } from "./minisig.ts";

export const packageRoot = fileURLToPath(new URL("./", import.meta.url));
export const releaseTag = "2026.10.01";
const filename = "tree-sitter-wasm.wasm";
const publicKey = parsePubKey(
  "RWQWdcLzFjpLqtjewtcZo71AHJVUFws3irxz2ColvNW/r0m4tHyxzDX5",
);

export function verifyArtifact(bytes: Buffer, signature: string): void {
  if (!verifyMinisign(bytes, parseSig(signature), publicKey))
    throw new Error("tree-sitter-wasm signature verification failed");
}

export function getTreeSitterWasmPath(): string | null {
  const override = process.env.CPI_TS_WASM;
  if (override) {
    if (!isAbsolute(override) || !existsSync(override))
      throw new Error("CPI_TS_WASM must name an absolute WASM file path");
    return override;
  }
  const bundled = join(packageRoot, "assets", filename);
  if (existsSync(bundled)) {
    verifyArtifact(
      readFileSync(bundled),
      readFileSync(`${bundled}.minisig`, "utf8"),
    );
    return bundled;
  }
  const development = join(packageRoot, "zig-out/bin", filename);
  if (existsSync(development)) return development;
  let release: string;
  try {
    release = createRequire(import.meta.url).resolve(
      "@bobcao3/cpi-tree-sitter-wasm/package.json",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND")
      return null;
    throw error;
  }
  const artifact = join(release, "../assets", filename);
  verifyArtifact(
    readFileSync(artifact),
    readFileSync(`${artifact}.minisig`, "utf8"),
  );
  return artifact;
}

export async function resolveTreeSitterWasm(): Promise<string> {
  const path = getTreeSitterWasmPath();
  if (!path)
    throw new Error(
      "Missing packaged tree-sitter WASM. Reinstall @cpi/tree-sitter-wasm, or build the checkout's WASM.",
    );
  return path;
}
