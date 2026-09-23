import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decorateFastProvider,
  isGeneratedFastModel,
} from "./fast-provider.mjs";
export { canonicalFastModel, isGeneratedFastModel } from "./fast-provider.mjs";

const INSTALLATION = Symbol.for("cpi.fast.runtime");
const CONFIG = Symbol.for("cpi.fast.config");
const EFFORT = /:(off|minimal|low|medium|high|xhigh|max)$/;

export function loadFastConfig(cwd = process.cwd()) {
  const defaults = JSON.parse(
    readFileSync(
      new URL("../cpi-config.default.json", import.meta.url),
      "utf8",
    ),
  ).fast;
  let config = { ...defaults };
  for (const path of [
    join(process.env.HOME ?? "", ".pi/agent/cpi-config.json"),
    join(cwd, ".pi/cpi-config.json"),
  ]) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(path, "utf8")).fast };
    } catch (error) {
      if (error.code !== "ENOENT")
        process.stderr.write(`[fast] ${path}: ${error.message}\n`);
    }
  }
  for (const key of ["providers", "models"]) {
    const list = config[key];
    config[key] =
      Array.isArray(list) &&
      list.length <= 64 &&
      list.every((item) => typeof item === "string" && item.trim())
        ? [...new Set(list.map((item) => item.trim()))]
        : [...defaults[key]];
  }
  return config;
}

export function installFastModels(
  ModelRuntime,
  config = () => loadFastConfig(),
) {
  const prototype = ModelRuntime.prototype;
  if (prototype[INSTALLATION]) {
    prototype[INSTALLATION].config = config;
    return;
  }
  const installation = { config };
  const compose = prototype.recomposeProvider;
  const prepare = prototype.prepareRequest;
  if (typeof compose !== "function" || typeof prepare !== "function")
    throw new Error(
      "Fast models require ModelRuntime provider composition and request preparation support",
    );
  Object.defineProperty(prototype, INSTALLATION, { value: installation });
  prototype.recomposeProvider = function (id) {
    compose.call(this, id);
    const selected = this[CONFIG] ?? installation.config();
    const provider = this.models.getProvider(id);
    if (provider && selected.providers.includes(id))
      this.models.setProvider(decorateFastProvider(provider, selected));
  };
  prototype.prepareRequest = async function (model, options) {
    if (
      (isGeneratedFastModel(model) || model.id.endsWith("-fast")) &&
      !this.getModel(model.provider, model.id)
    ) {
      throw new Error(`Fast model unavailable: ${model.provider}/${model.id}`);
    }
    return prepare.call(this, model, options);
  };
}

export async function initializeFastModels(runtime, cwd) {
  runtime[CONFIG] = loadFastConfig(cwd);
  await runtime.refresh({ allowNetwork: false });
}

export async function createFastRuntime(ModelRuntime, cwd) {
  installFastModels(ModelRuntime);
  const runtime = await ModelRuntime.create();
  await initializeFastModels(runtime, cwd);
  return runtime;
}

export function resolveFastModel(resolve, options) {
  const selector = options.cliModel?.toLowerCase().replace(EFFORT, "") ?? "";
  const runtime = options.modelRuntime;
  const models = runtime
    .getModels()
    .filter(
      (model) =>
        !isGeneratedFastModel(model) ||
        selector === model.id.toLowerCase() ||
        selector === `${model.provider}/${model.id}`.toLowerCase(),
    );
  const view = new Proxy(runtime, {
    get: (target, key) =>
      key === "getModels"
        ? () => models
        : typeof target[key] === "function"
          ? target[key].bind(target)
          : target[key],
  });
  const result = resolve({ ...options, modelRuntime: view });
  if (selector.endsWith("-fast")) {
    const slash = selector.lastIndexOf("/");
    const requestedId = selector.slice(slash + 1);
    const requestedProvider =
      slash < 0 ? options.cliProvider?.toLowerCase() : selector.slice(0, slash);
    if (
      !result.model ||
      result.model.id.toLowerCase() !== requestedId ||
      (requestedProvider &&
        result.model.provider.toLowerCase() !== requestedProvider) ||
      !runtime.getModel(result.model.provider, result.model.id)
    ) {
      throw new Error(`Fast model unavailable: ${selector}`);
    }
  }
  return result;
}
