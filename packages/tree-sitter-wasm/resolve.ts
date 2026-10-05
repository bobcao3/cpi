import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  return existsSync(development) ? development : null;
}

export async function resolveTreeSitterWasm(): Promise<string> {
  const path = getTreeSitterWasmPath();
  if (!path)
    throw new Error(
      "Missing packaged tree-sitter WASM. Reinstall @cpi/tree-sitter-wasm, or build the checkout's WASM.",
    );
  return path;
}
