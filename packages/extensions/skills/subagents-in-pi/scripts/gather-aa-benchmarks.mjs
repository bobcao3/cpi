#!/usr/bin/env node

import process from "node:process";

const ORIGIN = "https://artificialanalysis.ai";
const MAIN_URL = `${ORIGIN}/models`;
const MAX_ARGS = 6;
const MAX_HTML_BYTES = 16 * 1024 * 1024;
const MAX_FLIGHT_SCRIPTS = 512;
const MAX_OBJECT_BYTES = 512 * 1024;
const MAX_DEPTH = 256;
const MAX_MODELS = 2048;
const TIMEOUT_MS = 30_000;

function usage() {
  return [
    "Usage:",
    "  gather-aa-benchmarks.mjs",
    "  gather-aa-benchmarks.mjs <model-slug-or-AA-model-URL> [...]",
    "",
    "Without arguments, returns models embedded in the main comparison page.",
    "With slugs, returns all measured effort variants for those releases.",
  ].join("\n");
}

function requestFor(argument) {
  if (!argument) return { url: MAIN_URL };
  if (/^https?:\/\//i.test(argument)) {
    const url = new URL(argument);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "artificialanalysis.ai" ||
      !/^\/models\/[a-z0-9][a-z0-9-]{0,127}\/?$/.test(url.pathname)
    ) {
      throw new Error(`unsupported Artificial Analysis URL: ${argument}`);
    }
    const slug = url.pathname.split("/").filter(Boolean).at(-1);
    return { url: `${ORIGIN}/models/${slug}`, slug };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(argument)) {
    throw new Error(`invalid model slug: ${argument}`);
  }
  return { url: `${ORIGIN}/models/${argument}`, slug: argument };
}

async function responseText(response) {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.hostname !== "artificialanalysis.ai"
  ) {
    throw new Error(`unexpected redirect: ${response.url}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) {
    throw new Error(
      `${response.url}: expected HTML, received ${type || "unknown"}`,
    );
  }
  if (!response.body) throw new Error(`${response.url}: empty response body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error(
        `${response.url}: response exceeds ${MAX_HTML_BYTES} bytes`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "cpi-subagent-model-guide/1" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return responseText(response);
}

function flightChunks(html) {
  const chunks = [];
  const pattern = /<script>self\.__next_f\.push\((.*?)\)<\/script>/gs;
  for (const match of html.matchAll(pattern)) {
    if (chunks.length >= MAX_FLIGHT_SCRIPTS) {
      throw new Error(`page exceeds ${MAX_FLIGHT_SCRIPTS} flight scripts`);
    }
    try {
      const payload = JSON.parse(match[1]);
      if (typeof payload[1] === "string") chunks.push(payload[1]);
    } catch {
      continue;
    }
  }
  if (chunks.length === 0)
    throw new Error("Artificial Analysis page data not found");
  return chunks;
}

function candidateObject(text, start, end) {
  const length = end - start + 1;
  if (length > MAX_OBJECT_BYTES) return undefined;
  const json = text.slice(start, end + 1);
  if (
    !json.includes('"intelligenceIndex"') ||
    !json.includes('"intelligenceIndexCostPerTask"')
  ) {
    return undefined;
  }
  try {
    const model = JSON.parse(json);
    const intelligence = model.intelligenceIndex;
    const cost = model.intelligenceIndexCostPerTask?.cost?.total;
    return typeof model.name === "string" &&
      Number.isFinite(intelligence) &&
      Number.isFinite(cost)
      ? model
      : undefined;
  } catch {
    return undefined;
  }
}

function modelsFromChunk(text) {
  const models = [];
  const objects = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (objects.length >= MAX_DEPTH)
        throw new Error("page object depth limit exceeded");
      objects.push(index);
    } else if (character === "}") {
      const start = objects.pop();
      if (start === undefined) continue;
      const model = candidateObject(text, start, index);
      if (model) {
        models.push(model);
        if (models.length > MAX_MODELS) {
          throw new Error(`page exceeds ${MAX_MODELS} benchmark models`);
        }
      }
    }
  }
  return models;
}

function compactModel(model) {
  const number = (value) => (Number.isFinite(value) ? value : null);
  const releaseSlug = model.release?.slug ?? model.slug;
  return {
    id: model.id,
    slug: model.slug,
    releaseSlug,
    name: model.name,
    creator: model.creator?.name ?? null,
    releaseDate: model.releaseDate ?? null,
    reasoning: model.isReasoning === true,
    effort: model.effort?.slug ?? null,
    intelligenceIndex: model.intelligenceIndex,
    intelligenceEstimated: model.intelligenceIndexIsEstimated === true,
    costPerIntelligenceIndexTaskUsd:
      model.intelligenceIndexCostPerTask.cost.total,
    agenticIndex: number(model.agenticIndex),
    terminalBenchV21: number(model.terminalbenchV21),
    sciCode: number(model.scicode),
    critPt: number(model.critpt),
    outputTokensPerTask: number(
      model.intelligenceIndexOutputTokensPerTask?.output,
    ),
    medianOutputTokensPerSecond: number(model.timescaleData?.medianOutputSpeed),
    contextWindowTokens: number(model.contextWindowTokens),
    detailsUrl: `${ORIGIN}/models/${releaseSlug}`,
  };
}

function modelsFromPage(html, slug) {
  const found = [];
  for (const chunk of flightChunks(html)) {
    const models = modelsFromChunk(chunk);
    if (found.length + models.length > MAX_MODELS) {
      throw new Error(`page exceeds ${MAX_MODELS} benchmark models`);
    }
    found.push(...models);
  }
  const filtered = slug
    ? found.filter(
        (model) => model.slug === slug || model.release?.slug === slug,
      )
    : found;
  const unique = new Map();
  for (const model of filtered) unique.set(model.id ?? model.slug, model);
  if (slug && unique.size === 0) {
    throw new Error(`no scored effort variants found for ${slug}`);
  }
  return [...unique.values()];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.length > MAX_ARGS)
    throw new Error(`at most ${MAX_ARGS} models may be requested`);
  const requests = (args.length > 0 ? args : [undefined]).map(requestFor);
  const pages = await Promise.all(
    requests.map(async (request) => ({
      ...request,
      html: await fetchPage(request.url),
    })),
  );
  const unique = new Map();
  for (const page of pages) {
    for (const model of modelsFromPage(page.html, page.slug)) {
      unique.set(model.id ?? model.slug, compactModel(model));
    }
  }
  const models = [...unique.values()].sort(
    (left, right) =>
      left.releaseSlug.localeCompare(right.releaseSlug) ||
      (left.effort ?? "off").localeCompare(right.effort ?? "off"),
  );
  const versions = pages
    .flatMap((page) => [
      ...page.html.matchAll(
        /Artificial Analysis Intelligence Index v([0-9.]+)/g,
      ),
    ])
    .map((match) => match[1]);
  process.stdout.write(
    `${JSON.stringify(
      {
        attribution: "Artificial Analysis",
        retrievedAt: new Date().toISOString(),
        intelligenceIndexVersion: versions[0] ?? null,
        sourceUrls: pages.map((page) => page.url),
        models,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
