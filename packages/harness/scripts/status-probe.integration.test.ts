import "@cpi/cli/bootstrap";
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { localFixture } from "./local-fixture.mjs";
import { packagePath } from "./test-runtime.mjs";
import { until } from "./shell-persistence.integration.helper.mjs";

process.env.CPI_STATUS_REPORT_TURNS = "1";
delete process.env.CPI_FORK_PROBE;

test("status probes preserve summaries while tool turns, wait_any, and steering proceed", async () => {
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mainRequests = 0;
  let probes = 0;
  let mode = "read";
  const answer = "I'm testing background status probes.";
  const local = await localFixture(async (body: { messages: unknown[] }) => {
    if (
      JSON.stringify(body.messages.at(-1)).includes("Describe in one sentence")
    ) {
      probes++;
      await gate;
      return { content: answer };
    }
    if (++mainRequests === 1)
      return {
        tools: [
          {
            name: mode === "read" ? "read" : "wait_any",
            args:
              mode === "read" ? { path: join(local.directory, "marker") } : {},
          },
        ],
      };
    return { content: "MAIN_OK" };
  });
  const host = await hostCodingAgent();
  const extension = join(local.directory, "status-fixture.ts");
  await writeFile(join(local.directory, "marker"), "integration marker");
  await writeFile(
    extension,
    `import { setupStatusReports, disposeStatusReports, statusReportTurnStarted, statusReportTurnEnded } from ${JSON.stringify(packagePath("src/lib/status-report.ts"))};
export default function(pi) {
  pi.on("session_start", (_, ctx) => setupStatusReports(ctx));
  pi.on("session_shutdown", () => disposeStatusReports());
  pi.on("turn_start", (event, ctx) => statusReportTurnStarted(event, ctx));
  pi.on("turn_end", (event, ctx) => statusReportTurnEnded(pi, event, ctx));
}`,
  );
  const services = await host.createAgentSessionServices({
    cwd: local.directory,
    agentDir: local.agentDir,
    resourceLoaderOptions: {
      noExtensions: true,
      additionalExtensionPaths: [extension, packagePath("src/wait-any.ts")],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const manager = host.SessionManager.create(
    local.directory,
    join(local.directory, "sessions"),
  );
  const { session } = await host.createAgentSessionFromServices({
    services,
    sessionManager: manager,
    tools: ["read", "wait_any"],
  });
  const summaries = () =>
    manager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "cpi.status-report",
      );
  try {
    await session.bindExtensions({
      mode: "tui",
      onError: (error: unknown) => {
        throw new Error(JSON.stringify(error));
      },
    });
    await session.prompt("Read the marker then finish.");
    await until(
      () => probes >= 1,
      "Background summary did not reach the gated API",
    );
    expect(mainRequests).toBe(2);
    expect(session.isIdle).toBe(true);
    release();
    await until(
      () =>
        summaries().some(
          (entry) =>
            entry.type === "custom" &&
            (entry.data as { report: string }).report === answer,
        ),
      "Completed summary was not published",
    );

    mainRequests = 0;
    const previous = probes;
    mode = "wait";
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await session.prompt("Wait for an event.");
    await until(
      () => probes > previous,
      "wait_any did not start a background summary",
    );
    expect(mainRequests).toBe(1);
    expect(session.isIdle).toBe(true);
    await session.prompt("This is steering while the summary is waiting.", {
      streamingBehavior: "steer",
    });
    expect(mainRequests).toBe(2);
    const count = summaries().length;
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "reload",
    });
    release();
    await stopSubagentRpc();
    expect(summaries()).toHaveLength(count);
  } finally {
    release();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    await stopSubagentRpc();
    await local.close();
  }
}, 30000);
