import { hostCodingAgent } from "./host-pi.mjs";
import { observeSession } from "./subagent-activity.mjs";
import { createFastRuntime, resolveFastModel } from "./fast-models.mjs";
import { setSystemPromptOverride } from "../extensions/lib/system-prompt.ts";

const {
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} = await hostCodingAgent();

function resolveSelection(modelRuntime, request) {
  const resolved = resolveFastModel(resolveCliModel, {
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
    throw new Error("failed to bound subagent UTF-8 candidate");
  }
  return text;
}

function turnCandidate(request, session, turn) {
  const text = session.getLastAssistantText() || "";
  const output = Buffer.from(text, "utf8");
  const outputOverflow = output.length > request.maxOutputBytes;
  return {
    kind: "candidate",
    turn,
    text: outputOverflow ? truncateUtf8(output, request.maxOutputBytes) : text,
    outputOverflow,
  };
}

export async function runSubagentSession(request, signal, exchangeCandidate) {
  if (request.version !== 1 || request.kind !== "session") {
    throw new Error("unsupported subagent session protocol");
  }
  const agentDir = getAgentDir();
  const modelRuntime = await createFastRuntime(ModelRuntime, request.cwd);
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
  settingsManager.applyOverrides({ compaction: { enabled: false } });
  // Extensions load here, so the providers they register (fallback-providers)
  // are resolvable below, before the session resolves its model.
  const services = await createAgentSessionServices({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      ...(request.extensionPaths?.length
        ? { additionalExtensionPaths: request.extensionPaths }
        : {}),
      noSkills: true,
      noContextFiles: true,
      systemPrompt: request.systemPrompt,
    },
  });
  for (const diagnostic of services.diagnostics) {
    if (diagnostic.type !== "info")
      process.stderr.write(`${diagnostic.type}: ${diagnostic.message}\n`);
  }
  const selection = resolveSelection(modelRuntime, request);
  setSystemPromptOverride(request.systemPrompt);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(request.cwd),
    model: selection.model,
    thinkingLevel: request.thinkingLevel || selection.thinkingLevel,
    ...(request.tools ? { tools: request.tools } : { noTools: "all" }),
  });
  const unobserve = observeSession(session);
  // Automatic server caching may remain enabled.
  if (request.cacheRetention !== undefined) {
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) =>
      stream(model, context, {
        ...options,
        cacheRetention: request.cacheRetention,
        sessionId:
          request.cacheRetention === "none" ? undefined : options?.sessionId,
      });
  }
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
    let prompt = request.task;
    for (let turn = 0; turn < request.maxTurns; turn++) {
      if (interrupted) break;
      await session.prompt(prompt, { expandPromptTemplates: false });
      if (interrupted) break;
      const decision = await exchangeCandidate(
        turnCandidate(request, session, turn),
      );
      if (decision.kind !== "continue") break;
      prompt = decision.prompt;
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
    setSystemPromptOverride(undefined);
    unobserve();
    session.dispose();
  }
}
