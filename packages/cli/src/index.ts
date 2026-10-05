import "../bootstrap.mjs";
import {
  APP_NAME,
  type CreateAgentSessionOptions,
  type CreateAgentSessionServicesOptions,
  createAgentSessionServices as createPiServices,
  createAgentSession as createPiSession,
  getAgentDir,
  getPackageDir,
  type MainOptions,
  main as runPi,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  defaultExtensionFactories,
  defaultExtensionPaths,
  defaultSkillPaths,
  resourceOptions,
} from "./resources.ts";
import { createVcsSource } from "./vcs/index.ts";

if (APP_NAME !== "cpi")
  throw new Error("Load @cpi/cli/bootstrap before importing Pi modules");
process.env.CPI_HOST_ROOT = getPackageDir();

export * from "@earendil-works/pi-coding-agent";
export { DefaultResourceLoader } from "./resources.ts";
export { createVcsSource } from "./vcs/index.ts";

export function main(args: string[], options: MainOptions = {}) {
  return runPi(args, {
    createVcsSource,
    extensionFactories: defaultExtensionFactories,
    ...options,
    defaultExtensionPaths: [
      ...defaultExtensionPaths,
      ...(options.defaultExtensionPaths ?? []),
    ],
    defaultSkillPaths: [
      ...defaultSkillPaths,
      ...(options.defaultSkillPaths ?? []),
    ],
  });
}

export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
) {
  if (options.resourceLoader) return createPiSession(options);
  const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager =
    options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  return createPiSession({
    ...options,
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
  });
}

export function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
) {
  return createPiServices({
    ...options,
    resourceLoaderOptions: resourceOptions(options.resourceLoaderOptions),
  });
}
