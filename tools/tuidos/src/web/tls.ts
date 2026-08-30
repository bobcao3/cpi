import { existsSync, chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tuidosDir } from "../core/paths";

export interface CertificatePair {
  cert: string;
  key: string;
  source: "provided" | "self-signed";
}

function run(command: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
  });
}

function validCertificate(
  openssl: string,
  certPath: string,
  subjectNames: string[],
): boolean {
  if (!existsSync(certPath)) return false;
  if (
    run([openssl, "x509", "-checkend", "86400", "-noout", "-in", certPath])
      .exitCode !== 0
  )
    return false;
  return subjectNames.every(
    (name) =>
      run([
        openssl,
        "x509",
        isIP(name) > 0 ? "-checkip" : "-checkhost",
        name,
        "-noout",
        "-in",
        certPath,
      ]).exitCode === 0,
  );
}

async function loadPair(
  certPath: string,
  keyPath: string,
  source: CertificatePair["source"],
): Promise<CertificatePair> {
  if (!existsSync(certPath) || !existsSync(keyPath))
    throw new Error(
      `certificate files are incomplete — provide both --cert and --key, or remove them to generate a local pair`,
    );
  const [cert, key] = await Promise.all([
    Bun.file(certPath).text(),
    Bun.file(keyPath).text(),
  ]);
  if (!cert.includes("BEGIN CERTIFICATE") || !key.includes("PRIVATE KEY"))
    throw new Error(
      "certificate files are not PEM encoded — provide PEM certificate and key files",
    );
  return { cert, key, source };
}

export async function ensureCertificate(
  providedCert?: string,
  providedKey?: string,
  subjectNames: string[] = [],
): Promise<CertificatePair> {
  if (providedCert || providedKey) {
    if (!providedCert || !providedKey)
      throw new Error(
        "--cert and --key must be provided together — add the missing option",
      );
    return loadPair(providedCert, providedKey, "provided");
  }
  const directory = path.join(tuidosDir(), "tls");
  const certPath = path.join(directory, "localhost.crt");
  const keyPath = path.join(directory, "localhost.key");
  const openssl = Bun.which("openssl");
  const validatedSubjectNames = subjectNames
    .filter((name) => isIP(name) > 0 || /^[a-zA-Z0-9.-]+$/.test(name))
    .slice(0, 4);
  if (
    openssl &&
    validCertificate(openssl, certPath, validatedSubjectNames) &&
    existsSync(keyPath)
  )
    return loadPair(certPath, keyPath, "self-signed");
  if (!openssl)
    throw new Error(
      "OpenSSL is required to create local HTTPS credentials — install openssl, or pass --cert and --key",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporarySuffix = `.tmp-${randomUUID()}`;
  const temporaryCertPath = `${certPath}${temporarySuffix}`;
  const temporaryKeyPath = `${keyPath}${temporarySuffix}`;
  const subjectAltName = [
    "DNS:localhost",
    "IP:127.0.0.1",
    "IP:::1",
    ...validatedSubjectNames.map((name) =>
      isIP(name) > 0 ? `IP:${name}` : `DNS:${name}`,
    ),
  ].join(",");
  try {
    const result = run([
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "30",
      "-subj",
      "/CN=localhost",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=digitalSignature,keyEncipherment",
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-addext",
      `subjectAltName=${subjectAltName}`,
      "-keyout",
      temporaryKeyPath,
      "-out",
      temporaryCertPath,
    ]);
    if (result.exitCode !== 0) {
      const detail = result.stderr
        ? new TextDecoder().decode(result.stderr).trim().slice(0, 600)
        : "";
      throw new Error(
        `could not generate the local certificate — ${detail || "run openssl manually, then pass --cert and --key"}`,
      );
    }
    chmodSync(temporaryKeyPath, 0o600);
    chmodSync(temporaryCertPath, 0o644);
    renameSync(temporaryKeyPath, keyPath);
    renameSync(temporaryCertPath, certPath);
  } catch (error) {
    rmSync(temporaryKeyPath, { force: true });
    rmSync(temporaryCertPath, { force: true });
    throw error;
  }
  return loadPair(certPath, keyPath, "self-signed");
}

export interface Tailnet {
  dnsName: string;
  ipv4: string | null;
}

export function detectTailnet(): Tailnet | null {
  const executable = Bun.which("tailscale");
  if (!executable) return null;
  const result = run([executable, "status", "--json"]);
  const stdout = result.stdout ?? new Uint8Array();
  if (result.exitCode !== 0 || stdout.byteLength > 1_048_576) return null;
  try {
    const status = JSON.parse(new TextDecoder().decode(stdout)) as {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: unknown };
    };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "") ?? "";
    if (status.BackendState !== "Running" || !/^[a-zA-Z0-9.-]+$/.test(dnsName))
      return null;
    const ipv4 = Array.isArray(status.Self?.TailscaleIPs)
      ? (status.Self.TailscaleIPs.find(
          (value): value is string =>
            typeof value === "string" && isIP(value) === 4,
        ) ?? null)
      : null;
    return { dnsName, ipv4 };
  } catch {
    return null;
  }
}
