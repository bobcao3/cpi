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
  return import(required("CPI_APP_SDK_URL"));
}

export async function hostAi() {
  return import(required("CPI_HOST_AI_URL"));
}
