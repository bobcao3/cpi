#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  artifactName,
  packageRoot,
  platformKey,
  sourceDigest,
} from "./ghostmux-source.mjs";
import { verifyArtifact } from "./ghostmux-signature.mjs";

const [command, input, output, requestedPlatform] = process.argv.slice(2);
const digest = await sourceDigest();
if (command === "digest") {
  console.log(digest);
} else if (command === "stage" && input && output) {
  const platform = requestedPlatform || platformKey();
  const [os, architecture] = platform.split("-");
  platformKey(os, architecture);
  await mkdir(output, { recursive: true });
  const binary = join(output, artifactName(platform));
  await copyFile(input, binary);
  await writeFile(
    `${binary}.json`,
    JSON.stringify(
      {
        source_sha256: digest,
        platform,
        zig: "0.16.0",
        optimize: "ReleaseSafe",
        binary_sha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  const notices = join(output, "licenses");
  await mkdir(notices, { recursive: true });
  const source = join(
    packageRoot,
    "tools",
    "ghostmux",
    "zig-out",
    "share",
    "ghostmux",
  );
  for (const name of [
    "THIRD_PARTY_NOTICES.md",
    "OFL.txt",
    "LICENSE-nerd-fonts.txt",
    "ATTRIBUTIONS-nerd-fonts.md",
    "MANIFEST.sha256",
    "LICENSE-ghostty",
    "LICENSE-kb",
    "LICENSE-stb",
  ]) {
    const fontLicense = [
      "OFL.txt",
      "LICENSE-nerd-fonts.txt",
      "ATTRIBUTIONS-nerd-fonts.md",
      "MANIFEST.sha256",
    ].includes(name);
    await copyFile(
      join(source, fontLicense ? "fonts" : "", name),
      join(notices, name),
    );
  }
} else if (command === "sign" && input) {
  if (!process.env.CPI_MINISIGN_SECRET)
    throw new Error("CPI_MINISIGN_SECRET is required");
  const metadata = JSON.parse(await readFile(`${input}.json`, "utf8"));
  if (
    metadata.source_sha256 !== digest ||
    basename(input) !== artifactName(metadata.platform)
  )
    throw new Error("Ghostmux release provenance mismatch");
  const bytes = await readFile(input);
  if (
    createHash("sha256").update(bytes).digest("hex") !== metadata.binary_sha256
  )
    throw new Error("Ghostmux build digest mismatch");
  const secret = JSON.parse(process.env.CPI_MINISIGN_SECRET);
  const keyId = Buffer.from(secret.keyId, "hex");
  if (keyId.length !== 8) throw new Error("Invalid minisign key ID");
  const privateKey = createPrivateKey({
    key: Buffer.from(secret.pkcs8DerB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const comment = `ghostmux source:${digest} platform:${metadata.platform}`;
  const signature = sign(
    null,
    createHash("blake2b512").update(bytes).digest(),
    privateKey,
  );
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    privateKey,
  );
  const block = Buffer.concat([Buffer.from("ED"), keyId, signature]);
  const envelope = `untrusted comment: cpi ghostmux signature\n${block.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  verifyArtifact(bytes, envelope, digest, metadata.platform);
  await writeFile(`${input}.minisig`, envelope);
} else {
  throw new Error(
    "Usage: ghostmux-release.mjs digest | stage INPUT OUTPUT [PLATFORM] | sign INPUT",
  );
}
