import { hostCodingAgent } from "./host-pi.mjs";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeSession } from "./subagent-activity.mjs";
import { createFastRuntime, resolveFastModel } from "./fast-models.mjs";
import { SUBAGENT_USAGE, parseSubagentArgs } from "./subagent-args.mjs";
import {
  filterDisabledSkills,
  parseDisabledSkills,
} from "./disabled-skills.mjs";

const {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  createAgentSession,
} = await hostCodingAgent();

const THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MAX_PARENT_TAIL = 1024 * 1024;
const MAX_SESSION_FILES = 4096;

function readTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const length = Math.min(size, MAX_PARENT_TAIL);
    const data = Buffer.alloc(length);
    readSync(fd, data, 0, length, Math.max(0, size - length));
    return data.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lastJsonValue(text, key) {
  const expression = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "g");
  let value = "";
  for (const match of text.matchAll(expression)) value = match[1];
  return value;
}

function parentSettings(env) {
  const dir = env.PI_SESSION_DIR;
  const id = env.PI_SESSION_ID;
  if (!dir || !id) return { provider: "", thinking: "" };
  let names;
  try {
    names = readdirSync(dir).slice(0, MAX_SESSION_FILES);
  } catch {
    return { provider: "", thinking: "" };
  }
  const name = names.find((candidate) => candidate.endsWith(`_${id}.jsonl`));
  if (!name) return { provider: "", thinking: "" };
  const tail = readTail(join(dir, name));
  return {
    provider: lastJsonValue(tail, "provider"),
    thinking: lastJsonValue(tail, "thinkingLevel"),
  };
}

function selector(args, parent) {
  let model = args.model;
  let thinking = parent.thinking;
  const colon = model.lastIndexOf(":");
  if (colon >= 0 && THINKING.has(model.slice(colon + 1))) {
    thinking = model.slice(colon + 1);
    model = model.slice(0, colon);
  }
  const inheritedProvider = args.providerExplicit ? "" : parent.provider;
  let provider = args.providerExplicit ? args.provider : inheritedProvider;
  if (
    !args.providerExplicit &&
    inheritedProvider &&
    model.startsWith(`${inheritedProvider}/`)
  ) {
    model = model.slice(inheritedProvider.length + 1);
  } else if (!args.providerExplicit && model.includes("/")) {
    provider = "";
  }
  return { provider, model, thinking };
}

function subagentDir(env) {
  const parentDir = env.PI_SESSION_DIR;
  const parentSession = env.PI_SESSION;
  return parentDir && parentSession
    ? join(parentDir, `subagents_${parentSession}`)
    : undefined;
}

async function sessionManager(cwd, dir, id) {
  if (dir) await mkdir(dir, { recursive: true });
  if (id) {
    const sessions = await SessionManager.list(cwd, dir);
    const matches = sessions.filter((entry) => entry.id === id);
    if (matches.length > 1)
      throw new Error(`multiple sessions found with id ${id}`);
    if (matches.length === 1)
      return SessionManager.open(matches[0].path, dir, cwd);
  }
  return SessionManager.create(cwd, dir, id ? { id } : undefined);
}

function resolveSelection(modelRuntime, selected) {
  if (!selected.model) return {};
  const resolved = resolveFastModel(resolveCliModel, {
    cliProvider: selected.provider || undefined,
    cliModel: selected.model,
    cliThinking: selected.thinking || undefined,
    modelRuntime,
  });
  if (resolved.error) throw new Error(resolved.error);
  if (resolved.warning) process.stderr.write(`Warning: ${resolved.warning}\n`);
  return {
    model: resolved.model,
    thinkingLevel: selected.thinking || resolved.thinkingLevel,
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export async function runSubagent(request, signal) {
  const args = parseSubagentArgs(request.argv);
  if (!request.task) throw new Error(SUBAGENT_USAGE);
  const disabledSkills = parseDisabledSkills(args.disabledSkills);
  const cwd = request.cwd;
  const env = request.env;
  const parent = parentSettings(env);
  const selected = selector(args, parent);
  const agentDir = getAgentDir();
  const modelRuntime = await createFastRuntime(ModelRuntime, cwd);
  const selection = resolveSelection(modelRuntime, selected);
  const dir = subagentDir(env);
  const id =
    args.sessionId ||
    `sub-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14)}-${request.runId}`;
  const manager = await sessionManager(cwd, dir, id);
  const restored = manager.buildSessionContext().model;
  if (
    !selected.model &&
    restored?.modelId.endsWith("-fast") &&
    !modelRuntime.getModel(restored.provider, restored.modelId)
  ) {
    throw new Error(
      `Fast model unavailable: ${restored.provider}/${restored.modelId}`,
    );
  }
  const protocolPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "output-protocol.md",
  );
  const protocol = await readFile(protocolPath, "utf8");
  const oldSubagent = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const skillsOverride = disabledSkills.length
    ? (base) => {
        const { visible, missing } = filterDisabledSkills(
          base.skills,
          disabledSkills,
        );
        if (missing.length)
          throw new Error(
            `--disable-skill matched no loaded skill: ${missing.join(", ")}`,
          );
        return { ...base, skills: visible };
      }
    : undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: [protocol],
    skillsOverride,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    ...selection,
  });
  const unobserve = observeSession(session);
  let interrupted = signal?.aborted === true;
  const stop = () => {
    interrupted = true;
    void session.abort();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (interrupted) stop();
  try {
    await session.bindExtensions({
      mode: "print",
      onError: ({ extensionPath, error }) =>
        process.stderr.write(`Extension error (${extensionPath}): ${error}\n`),
    });
    await session.prompt(request.task);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    const last = session.messages.at(-1);
    return interrupted ||
      (last?.role === "assistant" &&
        ["error", "aborted"].includes(last.stopReason))
      ? 1
      : 0;
  } finally {
    signal?.removeEventListener("abort", stop);
    unobserve();
    session.dispose();
    restoreEnv("PI_SUBAGENT", oldSubagent);
  }
}
