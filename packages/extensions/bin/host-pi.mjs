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
  const url = required("CPI_APP_SDK_URL");
  if (!url.endsWith(".ts")) return import(url);
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, { tryNative: false }).import(url);
}

export async function hostAi() {
  return import(required("CPI_HOST_AI_URL"));
}
