import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtInExtensions,
  DefaultResourceLoader as PiResourceLoader,
} from "@earendil-works/pi-coding-agent";

type DefaultResourceLoaderOptions = ConstructorParameters<
  typeof PiResourceLoader
>[0];

const packageJsonPath = fileURLToPath(
  import.meta.resolve("@cpi/harness/package.json"),
);
const packageDirectory = dirname(packageJsonPath);
const packageManifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  pi: { extensions: string[]; skills: string[] };
};

export const defaultExtensionPaths = packageManifest.pi.extensions.map((path) =>
  resolve(packageDirectory, path),
);
export const defaultSkillPaths = packageManifest.pi.skills.map((path) =>
  resolve(packageDirectory, path),
);
export const defaultExtensionFactories = builtInExtensions.filter(
  (extension) => extension.name !== "codemode",
);

type ResourceOptions = Omit<
  DefaultResourceLoaderOptions,
  "cwd" | "agentDir" | "settingsManager"
>;

export function resourceOptions(
  options: ResourceOptions = {},
): ResourceOptions {
  return {
    ...options,
    extensionFactories: options.extensionFactories ?? defaultExtensionFactories,
    additionalExtensionPaths: [
      ...(options.noExtensions ? [] : defaultExtensionPaths),
      ...(options.additionalExtensionPaths ?? []),
    ],
    additionalSkillPaths: [
      ...(options.noSkills ? [] : defaultSkillPaths),
      ...(options.additionalSkillPaths ?? []),
    ],
  };
}

export class DefaultResourceLoader extends PiResourceLoader {
  constructor(options: DefaultResourceLoaderOptions) {
    super({ ...options, ...resourceOptions(options) });
  }
}
