import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  runPrintMode,
} from "@earendil-works/pi-coding-agent";

function selectModel(request, services, diagnostics) {
  if (!request.model) return {};
  const resolved = resolveCliModel({
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

export async function runForkProbeSubagent(request, signal) {
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
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader
        .getExtensions()
        .errors.map(({ path, error }) => ({
          type: "error",
          message: `Failed to load extension "${path}": ${error}`,
        })),
    ];
    const selection = selectModel(request, services, diagnostics);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools,
      ...selection,
    });
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
  started = true;
  try {
    return await runPrintMode(runtime, {
      mode: "text",
      initialMessage: request.prompt,
    });
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
