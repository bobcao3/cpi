import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRANSCRIPT_EXTENSION = join(
  ROOT,
  "extensions",
  "subagent-transcript",
  "index.ts",
);
const COST_EXTENSION = join(ROOT, "extensions", "cost-tree", "index.ts");
const COMPLETION_EXTENSION = join(
  ROOT,
  "extensions",
  "llm-editor",
  "completion.ts",
);

function resolveSelection(modelRuntime, request) {
  const resolved = resolveCliModel({
    cliProvider: request.provider,
    cliModel: request.modelId,
    cliThinking: request.thinkingLevel,
    modelRuntime,
  });
  if (resolved.error) throw new Error(resolved.error);
  if (resolved.warning) process.stderr.write(`Warning: ${resolved.warning}\n`);
  return resolved;
}

function lastAssistant(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") return messages[index];
  }
  return undefined;
}

async function readCompletion(path, role) {
  try {
    const completion = JSON.parse((await readFile(path, "utf8")).trim());
    const expectedTool =
      role === "viewer"
        ? "view-complete"
        : role === "editor"
          ? "edit-complete"
          : role;
    if (
      completion?.tool !== expectedTool ||
      !completion.args ||
      typeof completion.args !== "object" ||
      Array.isArray(completion.args)
    ) {
      return null;
    }
    return completion;
  } catch {
    return null;
  }
}

function truncateUtf8(output, maxBytes) {
  let text = output.subarray(0, maxBytes).toString("utf8");
  for (
    let trim = 0;
    trim < 4 && Buffer.byteLength(text, "utf8") > maxBytes;
    trim++
  ) {
    text = text.slice(0, -1);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("failed to bound llm-editor UTF-8 candidate");
  }
  return text;
}

async function turnCandidate(request, session, turn) {
  if (request.outputMode === "tool-call") {
    return {
      kind: "candidate",
      turn,
      completion: await readCompletion(request.completionPath, request.role),
      text: "",
      outputOverflow: false,
    };
  }
  const text = session.getLastAssistantText() || "";
  const output = Buffer.from(text, "utf8");
  const outputOverflow = output.length > request.maxOutputBytes;
  return {
    kind: "candidate",
    turn,
    completion: null,
    text: outputOverflow ? truncateUtf8(output, request.maxOutputBytes) : text,
    outputOverflow,
  };
}

export async function runLlmEditorSubagent(request, signal, exchangeCandidate) {
  if (request.version !== 1 && request.version !== 2) {
    throw new Error("unsupported llm-editor worker protocol");
  }
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const selection = resolveSelection(modelRuntime, request);
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
  settingsManager.applyOverrides({ compaction: { enabled: false } });
  const extensionPaths = [TRANSCRIPT_EXTENSION, COST_EXTENSION];
  if (request.outputMode === "tool-call")
    extensionPaths.push(COMPLETION_EXTENSION);
  const loader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    systemPrompt: request.systemPrompt,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(request.cwd),
    model: selection.model,
    thinkingLevel: request.thinkingLevel || selection.thinkingLevel,
    noTools: "builtin",
  });
  let interrupted = signal?.aborted === true;
  let bound = false;
  let shutdown = false;
  const stop = () => {
    interrupted = true;
    void session.abort();
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await session.bindExtensions({
      mode: "print",
      onError: ({ extensionPath, error }) =>
        process.stderr.write(`Extension error (${extensionPath}): ${error}\n`),
    });
    bound = true;
    if (request.version === 1) {
      if (!interrupted) {
        await session.prompt(request.task);
        const text = session.getLastAssistantText();
        if (request.outputMode === "text" && text) {
          process.stdout.write(`${text}\n`);
        }
      }
    } else {
      let prompt = request.task;
      for (let turn = 0; turn < request.maxTurns; turn++) {
        if (interrupted) break;
        if (request.outputMode === "tool-call") {
          await unlink(request.completionPath).catch(() => {});
        }
        await session.prompt(prompt, { expandPromptTemplates: false });
        if (interrupted) break;
        const decision = await exchangeCandidate(
          await turnCandidate(request, session, turn),
        );
        if (decision.kind !== "continue") break;
        prompt = decision.prompt;
      }
    }
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    shutdown = true;
    const last = lastAssistant(session.messages);
    return interrupted ||
      (last && ["error", "aborted"].includes(last.stopReason))
      ? 1
      : 0;
  } finally {
    if (bound && !shutdown) {
      await session.extensionRunner
        .emit({ type: "session_shutdown", reason: "quit" })
        .catch(() => {});
    }
    signal?.removeEventListener("abort", stop);
    session.dispose();
  }
}
