import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { registerTerminalCaptureTool } from "../src/shell/terminal-capture.ts";
import { localFixture } from "./local-fixture.mjs";
import { guardLocalSession } from "./test-runtime.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function start_writer(path) {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `const { writeFileSync } = require('node:fs');
process.stdin.on('end', () => {
  try {
    writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
  }
});
process.stdin.resume();
process.stdout.write('ready\\n');`,
      path,
      png.toString("base64"),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
      killSignal: "SIGKILL",
    },
  );
  let stderr = "";
  let spawn_error;
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    spawn_error = error;
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal, error: spawn_error }),
    );
  });
  const lines = createInterface({ input: child.stdout });
  const ready = bounded(
    Promise.race([
      once(lines, "line").then(([line]) => assert.equal(line, "ready")),
      closed.then((result) => {
        throw new Error(
          `writer exited before readiness: ${JSON.stringify(result)} ${stderr}`,
        );
      }),
    ]),
    5000,
    "writer readiness",
  ).finally(() => lines.close());
  return { child, ready, closed, stderr: () => stderr };
}

test(
  "unacknowledged screenshot retains an ownerless path until a real late writer finishes",
  { timeout: 40000, concurrency: false },
  async () => {
    const host = await hostCodingAgent();
    let requests = 0;
    const local = await localFixture(
      () => {
        assert.ok(
          ++requests <= 2,
          "the failed screenshot must not trigger a tool retry loop",
        );
        return requests === 1
          ? { tools: [{ name: "sh_screenshot", args: { id: "late-writer" } }] }
          : { content: "SCREENSHOT_FAILURE_HANDLED" };
      },
      { input: ["text", "image"] },
    );
    const previous_root = process.env.CPI_STORAGE_ROOT;
    const root = join(local.directory, "relocated-storage");
    process.env.CPI_STORAGE_ROOT = root;
    let session;
    let writer;
    let writer_joined = false;
    let output;
    try {
      const settings = host.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new host.DefaultResourceLoader({
        cwd: local.directory,
        agentDir: local.agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [
          (pi) =>
            registerTerminalCaptureTool(pi, async (_id, path) => {
              assert.equal(
                writer,
                undefined,
                "only one screenshot writer should be launched",
              );
              output = path;
              writer = start_writer(path);
              await writer.ready;
              throw new Error(
                "native screenshot watchdog expired after writer readiness",
              );
            }),
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await host.createAgentSession({
        cwd: local.directory,
        agentDir: local.agentDir,
        modelRuntime: local.runtime,
        model: local.model,
        thinkingLevel: "off",
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: host.SessionManager.inMemory(local.directory),
        tools: ["sh_screenshot"],
      }));
      guardLocalSession(session);
      await session.bindExtensions({});
      await bounded(
        session.prompt("Capture the terminal, then acknowledge any failure."),
        15000,
        "screenshot prompt",
      );
      assert.equal(
        session.getLastAssistantText(),
        "SCREENSHOT_FAILURE_HANDLED",
      );
      const results = session.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, "sh_screenshot");
      assert.equal(results[0].isError, true);
      const failure = results[0].content
        .map((part) => part.text ?? "")
        .join("\n");
      assert.match(
        failure,
        /native screenshot watchdog expired after writer readiness/,
      );
      assert.ok(
        writer,
        "the registered production tool must reach the capture callback",
      );
      assert.equal(writer.child.exitCode, null);
      assert.equal(writer.child.signalCode, null);
      const directory_survived = existsSync(dirname(output));
      assert.equal(
        existsSync(output),
        false,
        "the real child is still waiting for its finish gate",
      );
      writer.child.stdin.end();
      const result = await bounded(
        writer.closed,
        5000,
        "late screenshot write",
      );
      writer_joined = true;
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null, writer.stderr());
      assert.equal(
        result.code,
        0,
        `late screenshot writer failed: ${writer.stderr()}`,
      );
      assert.equal(
        directory_survived,
        true,
        "tool failure must not remove a live writer's parent directory",
      );
      assert.deepEqual(
        await readFile(output),
        png,
        "late output must remain readable after the failed prompt settles",
      );
      const suffix = relative(join(root, "state"), output);
      assert.ok(
        suffix &&
          !isAbsolute(suffix) &&
          suffix !== ".." &&
          !suffix.startsWith(`..${sep}`),
        output,
      );
      assert.equal(
        session.sessionManager.getSessionFile(),
        undefined,
        "this screenshot has no persistent session owner",
      );
      assert.ok(
        failure.includes(output),
        "failure must expose the retained output path",
      );
      assert.equal(local.requests.length, 2);
    } finally {
      try {
        if (writer) {
          writer.child.stdin.end();
          try {
            await bounded(writer.closed, 5000, "writer cleanup");
          } catch {
            writer.child.kill("SIGKILL");
            await bounded(writer.closed, 5000, "forced writer cleanup");
          }
          writer_joined = true;
        }
        session?.dispose();
      } finally {
        if (previous_root === undefined) delete process.env.CPI_STORAGE_ROOT;
        else process.env.CPI_STORAGE_ROOT = previous_root;
        if (!writer || writer_joined) await local.close();
      }
    }
  },
);
