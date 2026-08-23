import { isAbsolute } from "node:path";

const MAX_ARGV = 64;
const MAX_CLI_TASK_BYTES = 1024 * 1024;
const MAX_EDITOR_TASK_BYTES = 4 * 1024 * 1024;
const MAX_EDITOR_TURNS = 9;
const MAX_EDITOR_OUTPUT_BYTES = 1024 * 1024;
const MAX_EDITOR_COMPLETION_BYTES = 1024 * 1024;
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

export interface LlmEditorSubagentRequest {
  version: 2;
  kind: "llm-editor";
  role: "viewer" | "editor";
  systemPrompt: string;
  task: string;
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

export interface LlmEditorCompletion {
  tool: "view-complete" | "edit-complete";
  args: Record<string, unknown>;
}

export interface LlmEditorCandidate {
  kind: "candidate";
  turn: number;
  completion: LlmEditorCompletion | null;
  text: string;
  outputOverflow: boolean;
}

export type SubagentWorkerRequest =
  | CliSubagentRequest
  | LlmEditorSubagentRequest;

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

export function validLlmEditorSubagentRequest(
  value: unknown,
): value is LlmEditorSubagentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (
    request.version !== 2 ||
    request.kind !== "llm-editor" ||
    (request.role !== "viewer" && request.role !== "editor") ||
    (request.outputMode !== "tool-call" && request.outputMode !== "text") ||
    typeof request.maxTurns !== "number" ||
    !Number.isInteger(request.maxTurns) ||
    request.maxTurns < 1 ||
    request.maxTurns > MAX_EDITOR_TURNS ||
    typeof request.maxOutputBytes !== "number" ||
    !Number.isInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > MAX_EDITOR_OUTPUT_BYTES ||
    typeof request.systemPrompt !== "string" ||
    request.systemPrompt.length === 0 ||
    Buffer.byteLength(request.systemPrompt) > MAX_SYSTEM_PROMPT_BYTES ||
    typeof request.task !== "string" ||
    request.task.length === 0 ||
    Buffer.byteLength(request.task) > MAX_EDITOR_TASK_BYTES ||
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
    return request.completionPath === undefined;
  return (
    typeof request.completionPath === "string" &&
    isAbsolute(request.completionPath) &&
    Buffer.byteLength(request.completionPath) <= 4096 &&
    !request.completionPath.includes("\0")
  );
}

function validCompletion(
  value: unknown,
  expectedTool: LlmEditorCompletion["tool"],
): value is LlmEditorCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const completion = value as Record<string, unknown>;
  if (
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
      Buffer.byteLength(serialized) <= MAX_EDITOR_COMPLETION_BYTES
    );
  } catch {
    return false;
  }
}

export function validLlmEditorCandidate(
  value: unknown,
  request: LlmEditorSubagentRequest,
): value is LlmEditorCandidate {
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
      validCompletion(
        candidate.completion,
        request.role === "viewer" ? "view-complete" : "edit-complete",
      ))
  );
}

export function validLlmEditorCorrectionPrompt(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= MAX_CORRECTION_PROMPT_BYTES
  );
}
