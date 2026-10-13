import "@cpi/cli/bootstrap";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import { isGoalActive } from "../src/lib/goal.ts";
import { stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { localFixture } from "./local-fixture.mjs";
import { packagePath } from "./test-runtime.mjs";
import { until } from "./shell-persistence.integration.helper.mjs";

test("goal probes allow input, reject obsolete verdicts, and finish during headless shutdown", async () => {
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probes = 0;
  const local = await localFixture(
    async (body: { messages: { content: string }[] }) => {
      if (
        JSON.stringify(body.messages.at(-1)).includes("independent VERIFIER")
      ) {
        probes++;
        await gate;
        return { content: "YES\nVerified by the local integration fixture." };
      }
      return { content: "MAIN_OK" };
    },
  );
  const host = await hostCodingAgent();
  const extension = join(local.directory, "goal-fixture.ts");
  await writeFile(
    extension,
    `import { setGoal } from ${JSON.stringify(packagePath("src/lib/goal.ts"))};
export default function(pi) {
  pi.on("input", (event) => {
    if (event.text !== "SET_GOAL") return;
    setGoal(pi, "Finish the local fixture goal.");
    return { action: "handled" };
  });
}`,
  );
  const manager = host.SessionManager.create(
    local.directory,
    join(local.directory, "sessions"),
  );
  const runtime = await host.createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await host.createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          noExtensions: true,
          additionalExtensionPaths: [packagePath("src/core.ts"), extension],
        },
      });
      expect(services.resourceLoader.getExtensions().errors).toEqual([]);
      const created = await host.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd: local.directory, agentDir: local.agentDir, sessionManager: manager },
  );
  let disposed = false;
  try {
    await runtime.session.bindExtensions({
      mode: "tui",
      onError: (error: unknown) => {
        throw new Error(JSON.stringify(error));
      },
    });
    await runtime.session.prompt("SET_GOAL");
    await runtime.session.prompt("Finish the task.");
    await until(() => probes === 1, "Goal probe did not reach the gated API");
    expect(runtime.session.isIdle).toBe(true);
    await runtime.session.prompt("SET_GOAL");
    release();
    await stopSubagentRpc();
    expect(isGoalActive()).toBe(true);
    expect(
      manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "goal-eval",
        ),
    ).toHaveLength(0);

    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runtime.session.prompt("New user input must proceed.");
    await until(() => probes === 2, "Replacement goal probe did not start");
    expect(runtime.session.isIdle).toBe(true);
    release();
    await until(
      () => !isGoalActive(),
      "Current verdict did not achieve the goal",
    );

    await runtime.session.bindExtensions({ mode: "print" });
    await runtime.session.prompt("SET_GOAL");
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runtime.session.prompt("Check the headless lifecycle.");
    await until(() => probes === 3, "Headless evaluator did not start");
    const closing = runtime.dispose();
    release();
    await closing;
    disposed = true;
    expect(isGoalActive()).toBe(false);
    const audits = manager
      .getEntries()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "goal-eval",
      );
    expect(audits).toHaveLength(4);
  } finally {
    release();
    if (!disposed) await runtime.dispose();
    await stopSubagentRpc();
    await local.close();
  }
}, 30000);

for (const mode of ["text", "json"] as const)
  test(`${mode} mode reports the final answer after background goal continuations`, async () => {
    let probes = 0;
    let turns = 0;
    const local = await localFixture(async (body: { messages: unknown[] }) => {
      if (JSON.stringify(body.messages.at(-1)).includes("independent VERIFIER"))
        return {
          content:
            ++probes === 1
              ? "NO\nComplete the remaining work."
              : "YES\nCompleted.",
        };
      return { content: ++turns === 1 ? "HEADLESS_FIRST" : "HEADLESS_FINAL" };
    });
    const extension = join(local.directory, "headless-goal.ts");
    await writeFile(
      extension,
      `import { setGoal } from ${JSON.stringify(packagePath("src/lib/goal.ts"))};
export default function(pi) {
  pi.on("input", event => { if (event.text === "Finish the fixture goal.") setGoal(pi, "Finish the fixture goal."); });
}`,
    );
    const child = spawn(
      process.execPath,
      [
        piExecutableOnPath(),
        "--approve",
        "--print",
        "--mode",
        mode,
        "--no-context-files",
        "--no-extensions",
        "--provider",
        "local-fixture",
        "--model",
        "fixture",
        "-e",
        packagePath("src/core.ts"),
        "-e",
        extension,
        "Finish the fixture goal.",
      ],
      {
        cwd: local.directory,
        env: {
          ...process.env,
          CPI_CODING_AGENT_DIR: local.agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      const [code] = await once(child, "close");
      expect(stderr).not.toContain("Extension error");
      expect(code).toBe(0);
      expect(probes).toBe(2);
      expect(turns).toBe(2);
      if (mode === "text") expect(output.trim()).toBe("HEADLESS_FINAL");
      else {
        const answers = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (event) =>
              event.type === "message_end" &&
              event.message.role === "assistant",
          )
          .map((event) =>
            event.message.content
              .map((part: { text?: string }) => part.text ?? "")
              .join(""),
          );
        expect(answers).toEqual(["HEADLESS_FIRST", "HEADLESS_FINAL"]);
      }
    } finally {
      clearTimeout(deadline);
      child.kill();
      await local.close();
    }
  }, 20000);
