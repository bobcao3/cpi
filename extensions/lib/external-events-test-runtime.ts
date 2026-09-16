import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  EVENT_SOURCE_CHANNEL,
  type EventSourceHandle,
} from "./external-events.ts";

export function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function openEventRuntime() {
  const root = mkdtempSync(join(tmpdir(), "cpi-events-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const previous = {
    subagent: process.env.PI_SUBAGENT,
    probe: process.env.CPI_FORK_PROBE,
  };
  process.env.PI_SUBAGENT = "1";
  process.env.CPI_FORK_PROBE = "1";
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        replay: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1",
          apiKey: "unused",
          models: [
            {
              id: "replay",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let producer!: ExtensionAPI;
  let before_end: (() => void) | undefined;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      resolve("extensions/core.ts"),
      resolve("extensions/wait-any.ts"),
    ],
    extensionFactories: [
      (pi) => {
        producer = pi;
        pi.on("agent_end", () => before_end?.());
      },
    ],
    extensionsOverride: (loaded) => ({
      ...loaded,
      extensions: [...loaded.extensions].sort(
        (a, b) =>
          Number(b.path.startsWith("<inline")) -
          Number(a.path.startsWith("<inline")),
      ),
    }),
  });
  await loader.reload();
  if (loader.getExtensions().errors.length)
    throw new Error(JSON.stringify(loader.getExtensions().errors));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: runtime,
    model: runtime.getModel("replay", "replay")!,
    tools: ["wait_any"],
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  let turns = 0;
  let replay: (turn: number) => Promise<"wait" | "stop"> = async () => "wait";
  session.agent.streamFunction = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const outcome = await replay(++turns);
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: options?.signal?.aborted
          ? "aborted"
          : outcome === "wait"
            ? "toolUse"
            : "stop",
        content:
          outcome === "wait"
            ? [
                {
                  type: "toolCall",
                  id: `wait-${turns}`,
                  name: "wait_any",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "done" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (message.stopReason === "aborted")
        stream.push({ type: "error", reason: "aborted", error: message });
      else stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    })();
    return stream;
  };
  const watch = (id = "test-watch") => {
    let pending = true;
    let aborts = 0;
    const holding = gate();
    const queried = gate();
    let handle: EventSourceHandle | undefined;
    producer.events.emit(EVENT_SOURCE_CHANNEL, {
      id,
      hasPending: () => {
        queried.resolve();
        if ((globalThis as any).__cpiHold?.holdResolve) holding.resolve();
        return pending;
      },
      noticeText: () => "test observation",
      onAbort: () => {
        pending = false;
        aborts++;
      },
      reply: (value: EventSourceHandle) => {
        handle = value;
      },
    });
    if (!handle) throw new Error("Registration not acknowledged");
    return {
      handle,
      holding: holding.promise,
      queried: queried.promise,
      clear: () => {
        pending = false;
        handle!.changed();
      },
      get aborts() {
        return aborts;
      },
    };
  };
  return {
    session,
    errors,
    watch,
    get producer() {
      return producer;
    },
    get turns() {
      return turns;
    },
    setReplay: (fn: typeof replay) => {
      replay = fn;
    },
    beforeEnd: (fn?: () => void) => {
      before_end = fn;
    },
    async close() {
      await session.abort();
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      session.dispose();
      if (previous.subagent === undefined) delete process.env.PI_SUBAGENT;
      else process.env.PI_SUBAGENT = previous.subagent;
      if (previous.probe === undefined) delete process.env.CPI_FORK_PROBE;
      else process.env.CPI_FORK_PROBE = previous.probe;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
