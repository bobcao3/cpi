import { hostCodingAgent } from "./host-pi.mjs";
import { observeSession } from "./subagent-activity.mjs";
import {
  installFastModels,
  initializeFastModels,
  resolveFastModel,
} from "./fast-models.mjs";
import { selectForkProbeSubstitute } from "./fork-probe-model.mjs";

const {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
} = await hostCodingAgent();

const MAX_PROBE_TURNS = 4;
const MAX_OUTPUT_TOKENS_CEILING = 65536;

function selectModel(request, services, diagnostics, manager) {
  const restored = manager.buildSessionContext().model;
  if (
    !request.model &&
    restored?.modelId.endsWith("-fast") &&
    !services.modelRuntime.getModel(restored.provider, restored.modelId)
  ) {
    throw new Error(
      `Fast model unavailable: ${restored.provider}/${restored.modelId}`,
    );
  }
  if (!request.model)
    return selectForkProbeSubstitute(request, services, manager);
  const resolved = resolveFastModel(resolveCliModel, {
    cliModel: request.model,
    modelRuntime: services.modelRuntime,
  });
  if (resolved.warning) {
    diagnostics.push({ type: "warning", message: resolved.warning });
  }
  if (resolved.error) {
    diagnostics.push({ type: "error", message: resolved.error });
  }
  return {
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
  };
}

function capProbeOutput(session, maxOutputTokens) {
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING
  )
    return;
  const { model } = session.agent.state;
  if (!model || (model.maxTokens ?? Infinity) <= maxOutputTokens) return;
  session.agent.state.model = { ...model, maxTokens: maxOutputTokens };
}

function enabledTools(value) {
  if (!value) return undefined;
  const tools = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return tools.length ? tools : undefined;
}

function reportDiagnostics(runtime) {
  for (const diagnostic of runtime.diagnostics) {
    const prefix =
      diagnostic.type === "error"
        ? "Error"
        : diagnostic.type === "warning"
          ? "Warning"
          : "Info";
    process.stderr.write(`${prefix}: ${diagnostic.message}\n`);
  }
  if (runtime.modelFallbackMessage) {
    process.stderr.write(`Warning: ${runtime.modelFallbackMessage}\n`);
  }
  return runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
}

function restrictProbeTools(session, disabledMessage) {
  const agent = session.agent;
  agent.beforeToolCall = () => ({ block: true, reason: disabledMessage });
  let turns = 0;
  agent.shouldStopAfterTurn = ({ message }) => {
    turns += 1;
    return (
      !message.content.some((part) => part.type === "toolCall") ||
      turns >= MAX_PROBE_TURNS
    );
  };
}

export async function runForkProbeSubagent(request, signal) {
  installFastModels(ModelRuntime);
  const manager = SessionManager.forkFrom(
    request.parentSessionFile,
    request.cwd,
    request.sessionDir,
    { id: request.parentSessionId },
  );
  if (manager.getSessionId() !== request.parentSessionId) {
    throw new Error("fork-probe session identity mismatch");
  }
  const agentDir = getAgentDir();
  const tools = enabledTools(request.tools);
  const createRuntime = async ({
    cwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: request.appendSystemPrompt
        ? { appendSystemPrompt: [request.appendSystemPrompt] }
        : undefined,
    });
    await initializeFastModels(services.modelRuntime, cwd);
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader
        .getExtensions()
        .errors.map(({ path, error }) => ({
          type: "error",
          message: `Failed to load extension "${path}": ${error}`,
        })),
    ];
    const selection = selectModel(
      request,
      services,
      diagnostics,
      sessionManager,
    );
    services.settingsManager.applyOverrides({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools,
      ...selection,
    });
    restrictProbeTools(created.session, request.toolsDisabledMessage);
    return { ...created, services, diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: request.cwd,
    agentDir,
    sessionManager: manager,
  });
  if (reportDiagnostics(runtime) || signal?.aborted) {
    await runtime.dispose();
    return 1;
  }

  let started = false;
  const stop = () => {
    if (started) void runtime.session.abort();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener("abort", stop);
    await runtime.dispose();
    return 1;
  }
  const unobserve = observeSession(runtime.session);
  let assistant;
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      assistant = event.message;
    }
  });
  started = true;
  try {
    await runtime.session.bindExtensions({
      mode: "print",
      onError: ({ extensionPath, error }) =>
        process.stderr.write(`Extension error (${extensionPath}): ${error}\n`),
    });
    if (signal?.aborted) return 1;
    capProbeOutput(runtime.session, request.maxOutputTokens);
    await runtime.session.prompt(request.prompt);
    if (
      signal?.aborted ||
      !assistant ||
      ["error", "aborted"].includes(assistant.stopReason)
    )
      return 1;
    const answer = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!answer) return 1;
    return 0;
  } finally {
    unsubscribe();
    unobserve();
    signal?.removeEventListener("abort", stop);
    await runtime.dispose();
  }
}
