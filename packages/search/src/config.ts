import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { public_url } from "./http.ts";
import { PROVIDER_NAMES, type ProviderName } from "./types.ts";

export interface SearchConfig {
  providers: ProviderName[];
  timeoutMs: number;
  maxCharacters: number;
  codexModel: string | null;
  searxngUrl: string | null;
}

function read_config(path: string | URL): Partial<SearchConfig> {
  if (typeof path === "string" && !existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Search configuration must be an object");
  for (const key of Object.keys(value))
    if (
      ![
        "providers",
        "timeoutMs",
        "maxCharacters",
        "codexModel",
        "searxngUrl",
      ].includes(key)
    )
      throw new Error(`Unknown search configuration key: ${key}`);
  return value;
}

export function search_config(cwd: string, trusted: boolean): SearchConfig {
  const config = {
    ...read_config(new URL("../search.default.json", import.meta.url)),
    ...read_config(join(getAgentDir(), "search.json")),
    ...(trusted ? read_config(join(cwd, ".cpi", "search.json")) : {}),
  } as SearchConfig;
  if (process.env.CPI_SEARCH_PROVIDERS !== undefined)
    config.providers = process.env.CPI_SEARCH_PROVIDERS.split(",").map((name) =>
      name.trim(),
    ) as ProviderName[];
  if (
    !Array.isArray(config.providers) ||
    !config.providers.length ||
    config.providers.some((name) => !PROVIDER_NAMES.includes(name)) ||
    new Set(config.providers).size !== config.providers.length
  )
    throw new Error(
      `Search providers must be a nonempty ordered list of unique names: ${PROVIDER_NAMES.join(", ")}`,
    );
  if (process.env.CPI_SEARCH_SEARXNG_URL !== undefined)
    config.searxngUrl = process.env.CPI_SEARCH_SEARXNG_URL || null;
  else if (!config.searxngUrl && process.env.SEARXNG_URL)
    config.searxngUrl = process.env.SEARXNG_URL;
  if (process.env.CPI_SEARCH_TIMEOUT_MS !== undefined)
    config.timeoutMs = Number(process.env.CPI_SEARCH_TIMEOUT_MS);
  for (const [key, min, max] of [
    ["timeoutMs", 100, 120000],
    ["maxCharacters", 500, 50000],
  ] as const)
    if (
      !Number.isInteger(config[key]) ||
      config[key] < min ||
      config[key] > max
    )
      throw new Error(
        `Search ${key} must be an integer between ${min} and ${max}`,
      );
  if (
    config.codexModel !== null &&
    (typeof config.codexModel !== "string" || !config.codexModel.trim())
  )
    throw new Error("Search codexModel must be a nonempty model id or null");
  if (config.searxngUrl !== null) {
    if (typeof config.searxngUrl !== "string")
      throw new Error("Search searxngUrl must be a URL or null");
    public_url(config.searxngUrl);
  }
  return config;
}
