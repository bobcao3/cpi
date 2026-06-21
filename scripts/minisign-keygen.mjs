#!/usr/bin/env node
/**
 * Generate a minisign keypair for signing the tree-sitter wasm release.
 *
 * Zero deps (node:crypto). Produces a standard-format minisign public key
 * (base64 of sig_alg "Ed" | key_id[8] | ed25519_pub[32] = 42 bytes) and a
 * secret file under ~/.ssh/ holding the PKCS#8 Ed25519 private key + key_id (never inside the repo; CI gets it via the CPI_MINISIGN_SECRET Actions secret).
 *
 * The public key is printed; commit it (extensions/shell reads it at runtime).
 * The secret (~/.ssh/cpi-minisign-secret.json) lives outside the repo; in CI it is provided via the CPI_MINISIGN_SECRET environment variable.
 *
 * Validated: signatures from scripts/sign-wasm.mjs verify under
 * extensions/lib/minisig.ts (reference-validated against real minisign vectors).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "der" },
  publicKeyEncoding: { type: "spki", format: "der" },
});

const keyId = randomBytes(8);
const pubRaw = publicKey.subarray(publicKey.length - 32); // SPKI: last 32 bytes = raw Ed25519 pub
const pubBox = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, pubRaw]); // "Ed" | key_id | pub
const pubkeyB64 = pubBox.toString("base64");

const secretDir = join(homedir(), ".ssh");
if (!existsSync(secretDir)) mkdirSync(secretDir, { recursive: true, mode: 0o700 });
const secretPath = join(secretDir, "cpi-minisign-secret.json");
const secret = { keyId: keyId.toString("hex"), pkcs8DerB64: privateKey.toString("base64"), pubkeyB64 };
writeFileSync(secretPath, JSON.stringify(secret, null, 2) + "\n", { mode: 0o600 });
chmodSync(secretPath, 0o600);

console.log("minisign public key (base64):");
console.log(pubkeyB64);
console.log("secret written to " + secretPath + " (chmod 600; outside repo)");
console.log("to enable CI signing: gh secret set CPI_MINISIGN_SECRET --repo <owner/repo> < " + secretPath);
