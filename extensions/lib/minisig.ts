/**
 * Minisign signature verification — pure node:crypto (zero deps), for the
 * tree-sitter wasm download. Format (jedisct1/minisign): pubkey = "Ed"|key_id
 * [8]|ed25519_pub[32]; sig block = sig_alg|key_id[8]|sig[64] (74 bytes).
 * "ED" sigs are prehashed (blake2b512); "Ed" verifies the message directly.
 */

import {
  createHash,
  createPublicKey,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

const TRUSTED_PREFIX = "trusted comment: ";

export interface MinisignPubKey {
  keyId: Buffer;
  key: Buffer;
}

export interface MinisignSig {
  keyId: Buffer;
  sig: Buffer;
  trustedComment: string;
  globalSig: Buffer;
  prehashed: boolean;
}

export function parsePubKey(b64: string): MinisignPubKey {
  const bin = Buffer.from(b64.trim(), "base64");
  if (bin.length !== 42)
    throw new Error(`minisign: pubkey len ${bin.length} (want 42)`);
  if (bin[0] !== 0x45 || (bin[1] !== 0x64 && bin[1] !== 0x44)) {
    throw new Error(
      `minisign: bad pubkey sig_alg 0x${bin[0].toString(16)}0x${bin[1].toString(16)}`,
    );
  }
  return {
    keyId: Buffer.from(bin.subarray(2, 10)),
    key: Buffer.from(bin.subarray(10, 42)),
  };
}

export function parseSig(text: string): MinisignSig {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 4)
    throw new Error(`minisign: sig has ${lines.length} lines (want >=4)`);
  const b1 = Buffer.from(lines[1].trim(), "base64");
  if (b1.length !== 74)
    throw new Error(`minisign: sig block len ${b1.length} (want 74)`);
  const tc = lines[2];
  if (!tc.startsWith(TRUSTED_PREFIX))
    throw new Error("minisign: missing 'trusted comment:' line");
  const b2 = Buffer.from(lines[3].trim(), "base64");
  if (b2.length !== 64)
    throw new Error(`minisign: global sig len ${b2.length} (want 64)`);

  const a0 = b1[0],
    a1 = b1[1];
  const prehashed = a0 === 0x45 && a1 === 0x44;
  if (!(a0 === 0x45 && (a1 === 0x64 || a1 === 0x44))) {
    throw new Error(
      `minisign: unsupported sig_alg 0x${a0.toString(16)}0x${a1.toString(16)}`,
    );
  }
  return {
    keyId: Buffer.from(b1.subarray(2, 10)),
    sig: Buffer.from(b1.subarray(10, 74)),
    trustedComment: tc.slice(TRUSTED_PREFIX.length),
    globalSig: Buffer.from(b2),
    prehashed,
  };
}

function ed25519KeyObject(rawPub32: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawPub32.toString("base64url") },
    format: "jwk",
  });
}

export function verifyMinisign(
  message: Buffer,
  sig: MinisignSig,
  pub: MinisignPubKey,
): boolean {
  if (!pub.keyId.equals(sig.keyId)) return false;
  const data = sig.prehashed
    ? createHash("blake2b512").update(message).digest()
    : message;
  const pubKey = ed25519KeyObject(pub.key);
  if (!edVerify(null, data, pubKey, sig.sig)) return false;
  const global = Buffer.concat([
    sig.sig,
    Buffer.from(sig.trustedComment, "utf8"),
  ]);
  return edVerify(null, global, pubKey, sig.globalSig);
}
