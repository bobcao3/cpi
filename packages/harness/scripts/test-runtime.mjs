import "./loopback-network.mjs";
import assert from "node:assert/strict";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@cpi/cli";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const packagePath = (path) => resolve(packageRoot, path);

export function assertLocalModel(model, expectedBaseUrl) {
  assert.ok(model, "Fixture model must resolve explicitly");
  const url = new URL(model.baseUrl);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    model.baseUrl,
  );
  if (expectedBaseUrl) assert.equal(model.baseUrl, expectedBaseUrl);
}

export function guardLocalSession(session) {
  const prompt = session.prompt.bind(session);
  session.prompt = (...args) => {
    assertLocalModel(session.model);
    return prompt(...args);
  };
  return session;
}

export function isolateAgent(directory) {
  const tools = resolve(getAgentDir(), "cache", "shell-tools");
  if (existsSync(tools))
    cpSync(tools, resolve(directory, "cache", "shell-tools"), {
      recursive: true,
    });
  const secrets = Object.keys(process.env).filter(
    (key) =>
      /(?:API_KEY|TOKEN|SECRET_KEY|CREDENTIALS)$/.test(key) ||
      key.startsWith("AWS_"),
  );
  const keys = [
    "CPI_CODING_AGENT_DIR",
    "PI_SESSION_DIR",
    "PI_OFFLINE",
    "NODE_OPTIONS",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "CPI_COST_SOCKET",
    "CPI_COST_RUN_ID",
    ...secrets,
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of [...secrets, "CPI_COST_SOCKET", "CPI_COST_RUN_ID"])
    delete process.env[key];
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  process.env.XDG_CONFIG_HOME = resolve(directory, "config");
  process.env.CPI_CODING_AGENT_DIR = directory;
  process.env.PI_SESSION_DIR = resolve(directory, "artifacts");
  process.env.PI_OFFLINE = "1";
  const policy = new URL("./loopback-network.mjs", import.meta.url).href;
  process.env.NODE_OPTIONS =
    `${process.env.NODE_OPTIONS ?? ""} --import=${policy}`.trim();
  assert.equal(getAgentDir(), directory);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
