import { createJiti } from "jiti";
import { join } from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

export function activePiRoot() {
  return required("CPI_HOST_ROOT");
}

export function piExecutableOnPath() {
  return required("CPI_HOST_CLI");
}

export async function hostCodingAgent() {
  return loadHost(required("CPI_APP_SDK_URL"));
}

async function loadHost(url) {
  if (!url.endsWith(".ts")) return import(url);
  return createJiti(import.meta.url, {
    tryNative: false,
    ...(process.env.CPI_FORK
      ? { tsconfigPaths: join(process.env.CPI_FORK, "tsconfig.json") }
      : {}),
  }).import(url);
}

export async function hostAi() {
  return loadHost(required("CPI_HOST_AI_URL"));
}

export async function hostTui() {
  return loadHost(required("CPI_HOST_TUI_URL"));
}
