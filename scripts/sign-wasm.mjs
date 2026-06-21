#!/usr/bin/env node
/**
 * Sign a file with the minisign keypair from scripts/minisign-keygen.mjs.
 *
 * Zero deps (node:crypto). Emits a standard minisign signature file
 * (prehashed "ED" algorithm: ed25519(blake2b-512(msg)) + global sig over
 * sig||trusted_comment), written next to the input as <file>.minisig.
 *
 * Usage: node scripts/sign-wasm.mjs <path-to-wasm>
 *
 * Output verifies under extensions/lib/minisig.ts (the runtime verifier) and
 * under the reference minisign CLI (standard format).
 */
import { createPrivateKey, createHash, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const [wasmPath] = process.argv.slice(2);
if (!wasmPath) {
  console.error("usage: node scripts/sign-wasm.mjs <wasm-file>");
  process.exit(1);
}

const secretJson = process.env.CPI_MINISIGN_SECRET;
const secret = secretJson
  ? JSON.parse(secretJson)
  : JSON.parse(readFileSync(join(homedir(), ".ssh", "cpi-minisign-secret.json"), "utf8"));
const priv = createPrivateKey({ key: Buffer.from(secret.pkcs8DerB64, "base64"), format: "der", type: "pkcs8" });
const keyId = Buffer.from(secret.keyId, "hex");

const msg = readFileSync(wasmPath);
const hash = createHash("blake2b512").update(msg).digest(); // prehashed
const sig = sign(null, hash, priv); // 64-byte Ed25519 signature over blake2b-512(msg)

const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(wasmPath)}`;
const global = sign(null, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), priv); // 64 bytes

// sig block: sig_alg "ED" (prehashed) | key_id | sig = 74 bytes
const sigBlock = Buffer.concat([Buffer.from([0x45, 0x44]), keyId, sig]);
const out =
  "untrusted comment: cpi tree-sitter-wasm signature\n" +
  sigBlock.toString("base64") + "\n" +
  "trusted comment: " + trustedComment + "\n" +
  global.toString("base64") + "\n";

const outPath = wasmPath + ".minisig";
writeFileSync(outPath, out);
console.log("wrote " + outPath);
