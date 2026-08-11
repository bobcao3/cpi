#!/usr/bin/env node
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
const USAGE =
  "usage: subagent [-p provider] [-m [provider/]model[:effort]] [-s session-id] [task]";

function parseArgs(argv) {
  const result = {
    provider: "",
    providerExplicit: false,
    model: "",
    sessionId: "",
    task: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return { ...result, task: argv.slice(i + 1) };
    if (arg === "-p" || arg === "-m" || arg === "-s") {
      const value = argv[++i];
      if (!value) throw new Error(USAGE);
      if (arg === "-p") {
        result.provider = value;
        result.providerExplicit = true;
      } else if (arg === "-m") result.model = value;
      else result.sessionId = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(USAGE);
    result.task.push(arg);
  }
  return result;
}

async function readTask(positional) {
  if (positional.length) return positional.join(" ");
  if (process.stdin.isTTY) throw new Error(USAGE);
  let task = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) task += chunk;
  if (!task) throw new Error(USAGE);
  return task;
}

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

function parentSettings() {
  const dir = process.env.PI_SESSION_DIR;
  const id = process.env.PI_SESSION_ID;
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

function subagentDir() {
  const parentDir = process.env.PI_SESSION_DIR;
  const parentSession = process.env.PI_SESSION;
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
  const resolved = resolveCliModel({
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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const task = await readTask(args.task);
  const cwd = process.cwd();
  const parent = parentSettings();
  const selected = selector(args, parent);
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const selection = resolveSelection(modelRuntime, selected);
  const dir = subagentDir();
  const id =
    args.sessionId ||
    `sub-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14)}-${process.pid}`;
  const manager = await sessionManager(cwd, dir, id);
  const protocolPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "output-protocol.md",
  );
  const protocol = await readFile(protocolPath, "utf8");
  const summaryPath = join(
    tmpdir(),
    `cpi-subagent-${process.pid}-${Date.now()}.summary`,
  );
  process.env.PI_SUBAGENT = "1";
  process.env.PI_SUBAGENT_SUMMARY = summaryPath;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: [protocol],
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
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void session.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await session.bindExtensions({
      mode: "print",
      onError: ({ extensionPath, error }) =>
        process.stderr.write(`Extension error (${extensionPath}): ${error}\n`),
    });
    await session.prompt(task);
    const answer = session.getLastAssistantText();
    if (answer) process.stdout.write(`${answer}\n`);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    try {
      process.stdout.write(readFileSync(summaryPath, "utf8"));
    } catch {}
    const last = session.messages.at(-1);
    if (
      interrupted ||
      (last?.role === "assistant" &&
        ["error", "aborted"].includes(last.stopReason))
    ) {
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    session.dispose();
    try {
      unlinkSync(summaryPath);
    } catch {}
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
