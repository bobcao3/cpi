import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@cpi/cli";
import { localFixture } from "../local-fixture.mjs";
import { guardLocalSession, packagePath } from "../test-runtime.mjs";
import { sendCostReport } from "../../src/cost-tree/socket.ts";
import { type ContextCheckpoint } from "../../src/lib/compaction-checkpoint.ts";
import { compactedNotificationFilter } from "../../src/lib/compaction-display.ts";
import { collectRuntimeState } from "../../src/lib/compaction-state.ts";
import { setCwd } from "../../src/lib/cwd.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Fixture = {
  manager: SessionManager;
  session: Session;
  pi: ExtensionAPI;
  settings: SettingsManager;
  noticeHidden: ReturnType<typeof compactedNotificationFilter>;
};
let active: Fixture;
export const current = () => active;
export const control = {
  during_summary: undefined as (() => Promise<unknown> | unknown) | undefined,
  summaries: 0,
  request_tokens: 256,
};
export const local = await localFixture(
  async (body) => {
    if (!body.tools?.some((tool) => tool.function.name === "summarize_context"))
      return { content: "READY", inputTokens: control.request_tokens };
    control.summaries++;
    assert(control.during_summary, "Unexpected summary request");
    await control.during_summary();
    return {
      content: JSON.stringify({
        summary:
          "## Goal\nPreserve CONCURRENCY_TASK.\n## Progress\nTesting concurrent appends.\n## Next Steps\nContinue verification.",
        relevant_skills: [],
      }),
    };
  },
  { contextWindow: 32768 },
);
const errors: string[] = [];
const notices: string[] = [];
let cases = 0;

export async function open() {
  const cwd = join(local.directory, `case-${++cases}`);
  mkdirSync(cwd);
  setCwd(cwd);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 256, reserveTokens: 16384 },
    retry: { enabled: false },
  });
  settings.setProjectTrusted(true);
  let pi!: ExtensionAPI;
  let noticeHidden!: Fixture["noticeHidden"];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: local.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      "src/lib/compaction.ts",
      "src/cost-tree/index.ts",
      "src/alarm.ts",
      "src/shell.ts",
    ].map(packagePath),
    extensionFactories: [
      (api) => {
        pi = api;
        noticeHidden = compactedNotificationFilter(api);
        api.on("session_compact", () => settings.setCompactionEnabled(false));
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir: local.agentDir,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    modelRuntime: local.runtime,
    model: local.model,
    thinkingLevel: "off",
    noTools: "builtin",
  });
  active = { manager, session, pi, settings, noticeHidden };
  guardLocalSession(session);
  const ui = session.extensionRunner!.createContext().ui;
  await session.bindExtensions({
    mode: "print",
    uiContext: { ...ui, notify: (message) => notices.push(message) },
    onError: (event) => errors.push(event.error),
  });
  await session.prompt(
    "CONCURRENCY_TASK " + "Historical context. ".repeat(200),
  );
  await session.prompt(
    "Retained original user. " + "Recent context. ".repeat(200),
  );
}

export async function close() {
  const ctx = active.session.extensionRunner!.createToolContext(
    "cleanup",
    undefined,
  );
  const alarm = active.session.extensionRunner!.getToolDefinition("alarm")!;
  await alarm.execute("cleanup", { cancel: true }, undefined, undefined, ctx);
  await active.session.extensionRunner!.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  active.session.dispose();
}

export async function check(
  name: string,
  mutate: () => unknown | Promise<unknown>,
  failure?: RegExp,
) {
  await open();
  try {
    control.during_summary = mutate;
    notices.length = 0;
    const count = control.summaries;
    const previous = active.manager
      .getEntries()
      .filter(
        (entry) => entry.type === "compaction" && entry.fromHook === true,
      ).length;
    if (failure) {
      await assert.rejects(active.session.compact(), /Compaction cancelled/);
      assert.match(notices.join("\n"), failure);
      assert.equal(
        active.manager
          .getEntries()
          .filter(
            (entry) => entry.type === "compaction" && entry.fromHook === true,
          ).length,
        previous,
      );
    } else {
      const result = await active.session.compact().catch((error) => {
        throw new Error(`${name}: ${notices.join("\n")}`, { cause: error });
      });
      const checkpoint = (result.details as { cpiContext: ContextCheckpoint })
        .cpiContext;
      assert(checkpoint.boundaryId);
      assert(
        active.manager
          .getBranch()
          .some((entry) => entry.id === checkpoint.boundaryId),
      );
      assert.deepEqual(
        checkpoint.state,
        collectRuntimeState(active.session.extensionRunner!.createContext()),
      );
      assert.equal(notices.length, 0);
      const file = active.manager.getSessionFile()!;
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(
            SessionManager.open(file).buildSessionProjection().messages,
          ),
        ),
        JSON.parse(
          JSON.stringify(active.manager.buildSessionProjection().messages),
        ),
      );
    }
    assert.equal(control.summaries, count + 1);
    assert.deepEqual(errors, []);
    console.log(`compaction concurrency: ${name} passed`);
  } finally {
    await close();
  }
}

export function firstUser() {
  return active.manager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user")!
    .id;
}
export function lastUser() {
  return active.manager
    .getBranch()
    .slice()
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "user")!
    .id;
}
