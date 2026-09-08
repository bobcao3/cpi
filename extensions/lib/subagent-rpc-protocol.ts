import { isAbsolute } from "node:path";
import {
  validForkProbeModelRules,
  type ForkProbeModelRule,
} from "./fork-probe-config.ts";

const MAX_ARGV = 64;
const MAX_CLI_TASK_BYTES = 1024 * 1024;
const MAX_SESSION_TASK_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_TURNS = 9;
const MAX_SESSION_OUTPUT_BYTES = 1024 * 1024;
const MAX_SESSION_COMPLETION_BYTES = 1024 * 1024;
const MAX_CORRECTION_PROMPT_BYTES = 65536;
const MAX_SYSTEM_PROMPT_BYTES = 262144;
const MAX_ENV_ENTRIES = 512;
const MAX_ENV_BYTES = 1024 * 1024;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface CliSubagentRequest {
  version: 1;
  argv: string[];
  task: string;
  cwd: string;
  env: Record<string, string>;
  runId: string;
}

export interface SessionSubagentRequest {
  version: 1;
  kind: "session";
  extensionPaths: string[];
  tools?: string[];
  cacheRetention?: "none" | "short" | "long";
  completionTool?: string;
  systemPrompt: string;
  task: string;
  title?: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  outputMode: "tool-call" | "text";
  completionPath?: string;
  maxTurns: number;
  maxOutputBytes: number;
  cwd: string;
  env: Record<string, string>;
  runId: string;
}

export interface ForkProbeSubagentRequest {
  version: 1;
  kind: "fork-probe";
  modelSubstitutions?: ForkProbeModelRule[];
  parentSessionFile: string;
  parentSessionId: string;
  sessionDir: string;
  prompt: string;
  title?: string;
  model?: string;
  tools?: string;
  appendSystemPrompt?: string;
  toolsDisabledMessage: string;
  maxOutputTokens: number;
  cwd: string;
  env: Record<string, string>;
  runId: string;
}

export interface SubagentCompletion {
  tool: string;
  args: Record<string, unknown>;
}

export interface SubagentCandidate {
  kind: "candidate";
  turn: number;
  completion: SubagentCompletion | null;
  text: string;
  outputOverflow: boolean;
}

export type SubagentWorkerRequest =
  | CliSubagentRequest
  | SessionSubagentRequest
  | ForkProbeSubagentRequest;

function validCommonRequest(request: Record<string, unknown>): boolean {
  if (
    typeof request.cwd !== "string" ||
    !request.cwd ||
    Buffer.byteLength(request.cwd) > 4096 ||
    request.cwd.includes("\0") ||
    typeof request.runId !== "string" ||
    !/^[a-zA-Z0-9-]{1,96}$/.test(request.runId) ||
    !request.env ||
    typeof request.env !== "object" ||
    Array.isArray(request.env)
  )
    return false;
  const entries = Object.entries(request.env);
  if (entries.length > MAX_ENV_ENTRIES) return false;
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      return false;
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (totalBytes > MAX_ENV_BYTES) return false;
  }
  return true;
}

export function validCliSubagentRequest(
  value: unknown,
): value is CliSubagentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    request.version === 1 &&
    request.kind === undefined &&
    Array.isArray(request.argv) &&
    request.argv.length <= MAX_ARGV &&
    request.argv.every(
      (arg) => typeof arg === "string" && !arg.includes("\0"),
    ) &&
    typeof request.task === "string" &&
    request.task.length > 0 &&
    Buffer.byteLength(request.task) <= MAX_CLI_TASK_BYTES &&
    validCommonRequest(request)
  );
}

export function validForkProbeSubagentRequest(
  value: unknown,
): value is ForkProbeSubagentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    request.version === 1 &&
    request.kind === "fork-probe" &&
    (request.modelSubstitutions === undefined ||
      validForkProbeModelRules(request.modelSubstitutions)) &&
    typeof request.parentSessionFile === "string" &&
    isAbsolute(request.parentSessionFile) &&
    Buffer.byteLength(request.parentSessionFile) <= 4096 &&
    !request.parentSessionFile.includes("\0") &&
    typeof request.parentSessionId === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(
      request.parentSessionId,
    ) &&
    Buffer.byteLength(request.parentSessionId) <= 128 &&
    typeof request.sessionDir === "string" &&
    isAbsolute(request.sessionDir) &&
    Buffer.byteLength(request.sessionDir) <= 4096 &&
    !request.sessionDir.includes("\0") &&
    typeof request.prompt === "string" &&
    request.prompt.length > 0 &&
    Buffer.byteLength(request.prompt) <= 256 * 1024 &&
    !request.prompt.includes("\0") &&
    (request.title === undefined ||
      (typeof request.title === "string" &&
        request.title.length > 0 &&
        Buffer.byteLength(request.title) <= 4096 &&
        !request.title.includes("\0"))) &&
    (request.model === undefined ||
      (typeof request.model === "string" &&
        request.model.length > 0 &&
        Buffer.byteLength(request.model) <= 1024 &&
        !request.model.includes("\0"))) &&
    (request.tools === undefined ||
      (typeof request.tools === "string" &&
        request.tools.length > 0 &&
        Buffer.byteLength(request.tools) <= 4096 &&
        !request.tools.includes("\0"))) &&
    (request.appendSystemPrompt === undefined ||
      (typeof request.appendSystemPrompt === "string" &&
        Buffer.byteLength(request.appendSystemPrompt) <= 256 * 1024 &&
        !request.appendSystemPrompt.includes("\0"))) &&
    typeof request.toolsDisabledMessage === "string" &&
    request.toolsDisabledMessage.length > 0 &&
    Buffer.byteLength(request.toolsDisabledMessage) <= 4096 &&
    !request.toolsDisabledMessage.includes("\0") &&
    typeof request.maxOutputTokens === "number" &&
    Number.isInteger(request.maxOutputTokens) &&
    request.maxOutputTokens >= 1 &&
    request.maxOutputTokens <= 65536 &&
    validCommonRequest(request)
  );
}

function validStringList(
  value: unknown,
  maxEntries: number,
  maxBytes: number,
  absolute: boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxEntries &&
    new Set(value).size === value.length &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        Buffer.byteLength(entry) <= maxBytes &&
        !entry.includes("\0") &&
        (!absolute || isAbsolute(entry)),
    )
  );
}

export function validSessionSubagentRequest(
  value: unknown,
): value is SessionSubagentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1 ||
    request.kind !== "session" ||
    !validStringList(request.extensionPaths, 16, 4096, true) ||
    (request.tools !== undefined &&
      !validStringList(request.tools, 64, 128, false)) ||
    (request.cacheRetention !== undefined &&
      request.cacheRetention !== "none" &&
      request.cacheRetention !== "short" &&
      request.cacheRetention !== "long") ||
    (request.outputMode !== "tool-call" && request.outputMode !== "text") ||
    typeof request.maxTurns !== "number" ||
    !Number.isInteger(request.maxTurns) ||
    request.maxTurns < 1 ||
    request.maxTurns > MAX_SESSION_TURNS ||
    typeof request.maxOutputBytes !== "number" ||
    !Number.isInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > MAX_SESSION_OUTPUT_BYTES ||
    typeof request.systemPrompt !== "string" ||
    request.systemPrompt.length === 0 ||
    Buffer.byteLength(request.systemPrompt) > MAX_SYSTEM_PROMPT_BYTES ||
    typeof request.task !== "string" ||
    request.task.length === 0 ||
    Buffer.byteLength(request.task) > MAX_SESSION_TASK_BYTES ||
    (request.title !== undefined &&
      (typeof request.title !== "string" ||
        request.title.length === 0 ||
        Buffer.byteLength(request.title) > 4096 ||
        request.title.includes("\0"))) ||
    typeof request.provider !== "string" ||
    request.provider.length === 0 ||
    Buffer.byteLength(request.provider) > 256 ||
    request.provider.includes("\0") ||
    typeof request.modelId !== "string" ||
    request.modelId.length === 0 ||
    Buffer.byteLength(request.modelId) > 1024 ||
    request.modelId.includes("\0") ||
    (request.thinkingLevel !== undefined &&
      (typeof request.thinkingLevel !== "string" ||
        !THINKING_LEVELS.has(request.thinkingLevel))) ||
    !validCommonRequest(request)
  )
    return false;
  if (request.outputMode === "text")
    return (
      request.completionPath === undefined &&
      request.completionTool === undefined
    );
  return (
    typeof request.completionTool === "string" &&
    /^[A-Za-z0-9_./-]+$/.test(request.completionTool) &&
    Buffer.byteLength(request.completionTool) <= 128 &&
    typeof request.completionPath === "string" &&
    isAbsolute(request.completionPath) &&
    Buffer.byteLength(request.completionPath) <= 4096 &&
    !request.completionPath.includes("\0")
  );
}

export function validSubagentWorkerRequest(
  value: unknown,
): value is SubagentWorkerRequest {
  return (
    validCliSubagentRequest(value) ||
    validForkProbeSubagentRequest(value) ||
    validSessionSubagentRequest(value)
  );
}

function validCompletion(
  value: unknown,
  expectedTool: string | undefined,
): value is SubagentCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const completion = value as Record<string, unknown>;
  if (
    expectedTool === undefined ||
    completion.tool !== expectedTool ||
    !completion.args ||
    typeof completion.args !== "object" ||
    Array.isArray(completion.args)
  )
    return false;
  try {
    const serialized = JSON.stringify(completion.args);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized) <= MAX_SESSION_COMPLETION_BYTES
    );
  } catch {
    return false;
  }
}

export function validSubagentCandidate(
  value: unknown,
  request: SessionSubagentRequest,
): value is SubagentCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "candidate" ||
    typeof candidate.turn !== "number" ||
    !Number.isInteger(candidate.turn) ||
    candidate.turn < 0 ||
    candidate.turn >= request.maxTurns ||
    typeof candidate.text !== "string" ||
    Buffer.byteLength(candidate.text) > request.maxOutputBytes ||
    typeof candidate.outputOverflow !== "boolean"
  )
    return false;
  if (request.outputMode === "text") return candidate.completion === null;
  return (
    candidate.text === "" &&
    candidate.outputOverflow === false &&
    (candidate.completion === null ||
      validCompletion(candidate.completion, request.completionTool))
  );
}

export function validSubagentContinuationPrompt(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= MAX_CORRECTION_PROMPT_BYTES
  );
}
