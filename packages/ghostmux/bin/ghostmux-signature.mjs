import { createHash, createPublicKey, verify } from "node:crypto";
import { publicKey } from "./ghostmux-source.mjs";

export function verifyArtifact(bytes, signature, digest, platform) {
  const key = Buffer.from(publicKey, "base64");
  const lines = signature.trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("Invalid ghostmux minisign envelope");
  }
  const block = Buffer.from(lines[1], "base64");
  const global = Buffer.from(lines[3], "base64");
  const comment = lines[2].slice("trusted comment: ".length);
  if (
    block.length !== 74 ||
    global.length !== 64 ||
    block.subarray(0, 2).toString() !== "ED" ||
    !block.subarray(2, 10).equals(key.subarray(2, 10))
  ) {
    throw new Error("Invalid ghostmux minisign key or algorithm");
  }
  if (comment !== `ghostmux source:${digest} platform:${platform}`) {
    throw new Error(
      "Ghostmux artifact does not match the installed sources or platform",
    );
  }
  const publicObject = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: key.subarray(10).toString("base64url"),
    },
    format: "jwk",
  });
  const message = createHash("blake2b512").update(bytes).digest();
  const signed = block.subarray(10);
  if (
    !verify(null, message, publicObject, signed) ||
    !verify(
      null,
      Buffer.concat([signed, Buffer.from(comment)]),
      publicObject,
      global,
    )
  ) {
    throw new Error("Ghostmux artifact signature verification failed");
  }
}
