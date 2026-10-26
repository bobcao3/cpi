import type { Usage } from "@earendil-works/pi-ai";

export const PROVIDER_NAMES = ["codex", "exa", "searxng", "deepseek"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface SearchInput {
  query: string;
  numResults?: number;
}

export interface FetchInput {
  url: string;
  maxCharacters?: number;
}

export type Source = {
  url: string;
  title?: string;
};

export type ProviderResult = {
  text: string;
  sources: Source[];
  truncated?: boolean;
  usage?: Usage;
};

export interface SearchProvider {
  name: ProviderName;
  search(input: SearchInput, signal: AbortSignal): Promise<ProviderResult>;
  fetch(input: FetchInput, signal: AbortSignal): Promise<ProviderResult>;
}
