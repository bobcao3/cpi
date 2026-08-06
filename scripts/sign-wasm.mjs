#!/usr/bin/env node
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
  : JSON.parse(
      readFileSync(join(homedir(), ".ssh", "cpi-minisign-secret.json"), "utf8"),
    );
const priv = createPrivateKey({
  key: Buffer.from(secret.pkcs8DerB64, "base64"),
  format: "der",
  type: "pkcs8",
});
const keyId = Buffer.from(secret.keyId, "hex");

const msg = readFileSync(wasmPath);
const hash = createHash("blake2b512").update(msg).digest();
const sig = sign(null, hash, priv);

const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(wasmPath)}`;
const global = sign(
  null,
  Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]),
  priv,
);

const sigBlock = Buffer.concat([Buffer.from([0x45, 0x44]), keyId, sig]);
const out =
  "untrusted comment: cpi tree-sitter-wasm signature\n" +
  sigBlock.toString("base64") +
  "\n" +
  "trusted comment: " +
  trustedComment +
  "\n" +
  global.toString("base64") +
  "\n";

const outPath = wasmPath + ".minisig";
writeFileSync(outPath, out);
console.log("wrote " + outPath);
