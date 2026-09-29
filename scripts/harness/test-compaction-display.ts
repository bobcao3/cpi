import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  CustomMessageComponent,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { CustomEntryComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerCompaction } from "../../extensions/lib/compaction.ts";
import { buildCheckpoint } from "../../extensions/lib/compaction-checkpoint.ts";
import { COMPACTION_FEEDBACK } from "../../extensions/lib/compaction-display.ts";
import { registerNotificationRenderer } from "../../extensions/lib/notification.ts";
import { setCwd } from "../../extensions/lib/cwd.ts";
import { file, user } from "./test-compaction-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-compaction-display-"));
initTheme("dark");
setCwd(root);
const runtime = await ModelRuntime.create();
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir: root,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  additionalExtensionPaths: [resolve("extensions/cwd.ts")],
  extensionFactories: [registerCompaction, registerNotificationRenderer],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({
  cwd: root,
  agentDir: root,
  sessionManager: manager,
  resourceLoader: loader,
  settingsManager: settings,
  modelRuntime: runtime,
  model: runtime.getModel("openai", "gpt-4.1"),
  tools: [],
});
const errors: string[] = [];
await session.bindExtensions({
  mode: "print",
  onError: (event) => errors.push(event.error),
});

function notice(content: string, customType = "notification") {
  return manager.appendCustomMessageEntry(
    customType,
    content,
    true,
    customType === "notification"
      ? { kind: "shell-complete", summary: content, payload: {} }
      : { cwd: content },
  );
}
function rendered_notice(id: string) {
  const entry = manager.getEntry(id)!;
  const message = sessionEntryToContextMessages(entry)[0];
  assert.equal(message.role, "custom");
  if (message.role !== "custom") throw new Error("Expected custom message");
  const renderer = session.extensionRunner!.getMessageRenderer(
    message.customType,
  );
  assert(renderer);
  return new CustomMessageComponent(message, renderer).render(100).join("\n");
}
function rendered_feedback(id: string) {
  const entry = manager.getEntry(id)!;
  assert.equal(entry.type, "custom");
  if (entry.type !== "custom") throw new Error("Expected custom entry");
  const renderer =
    session.extensionRunner!.getEntryRenderer(COMPACTION_FEEDBACK);
  assert(renderer);
  return new CustomEntryComponent(entry, renderer).render(100).join("\n");
}
async function compact_fixture(summary: string, keep: string, empty = false) {
  const checkpoint = buildCheckpoint(
    {
      documents: empty
        ? []
        : [
            {
              kind: "project",
              path: file(join(root, "AGENTS.md"), "project body"),
              content: "project body",
            },
          ],
      warnings: empty ? ["Reference unavailable: missing.md"] : [],
    },
    {
      cwd: root,
      alarms: [],
      shells: [],
      repeats: [],
      subagents: [],
      environments: [],
    },
  );
  const id = manager.appendCompaction(summary, keep, 1000, {
    cpiContext: checkpoint,
  });
  const entry = manager.getEntry(id)!;
  assert(entry.type === "compaction");
  await session.extensionRunner!.emit({
    type: "session_compact",
    compactionEntry: entry,
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  });
  const feedback = manager.getEntry(manager.getLeafId()!)!;
  assert(
    feedback.type === "custom" && feedback.customType === COMPACTION_FEEDBACK,
  );
  return feedback.id;
}
try {
  const rewind = user(manager, "before compaction");
  const old_shell = notice("OLD_SHELL_FINISHED");
  const old_cwd = notice("OLD_CWD", "cwd-reminder");
  assert(rendered_notice(old_shell).includes("OLD_SHELL_FINISHED"));
  assert(rendered_notice(old_cwd).includes("OLD_CWD"));
  const feedback = await compact_fixture("task summary", rewind);
  const first_leaf = manager.getLeafId()!;
  const visual = rendered_feedback(feedback);
  assert(!visual.includes("Restored skills:"));
  assert(visual.includes(`Restored CWD at ${root}`));
  assert(visual.includes(`Loaded project instructions: ${root}/AGENTS.md`));
  assert(!rendered_notice(old_shell).includes("OLD_SHELL_FINISHED"));
  assert(!rendered_notice(old_cwd).includes("OLD_CWD"));
  assert(!rendered_notice(old_shell).includes("<notification"));
  const model_context = JSON.stringify(
    await session.extensionRunner!.emitContext(
      manager.buildSessionContext().messages,
    ),
  );
  assert(!model_context.includes("Restored skills:"));
  assert(!model_context.includes(COMPACTION_FEEDBACK));
  assert(
    model_context.includes("OLD_SHELL_FINISHED"),
    "UI filtering changed model context",
  );
  const new_notice = notice("NEW_SHELL_FINISHED");
  assert(rendered_notice(new_notice).includes("NEW_SHELL_FINISHED"));
  await session.reload();
  assert(rendered_feedback(feedback).includes("Restored CWD at"));
  assert(!rendered_notice(old_shell).includes("OLD_SHELL_FINISHED"));
  assert(rendered_notice(new_notice).includes("NEW_SHELL_FINISHED"));
  manager.branch(old_cwd);
  assert(rendered_notice(old_shell).includes("OLD_SHELL_FINISHED"));
  assert(rendered_notice(old_cwd).includes("OLD_CWD"));
  assert(!rendered_feedback(feedback).includes("Restored CWD at"));
  manager.branch(first_leaf);
  assert(!rendered_notice(old_shell).includes("OLD_SHELL_FINISHED"));
  const second = await compact_fixture("next summary", rewind, true);
  assert(!rendered_feedback(feedback).includes("Restored CWD at"));
  assert(rendered_feedback(second).includes("Restored CWD at"));
  assert(
    rendered_feedback(second).includes("Loaded project instructions: none"),
  );
  assert(
    rendered_feedback(second).includes("Reference unavailable: missing.md"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "compaction display: real SDK/TUI renderers, UI-only feedback, old/new notifications, reload, rewind, repeated compaction passed",
  );
} finally {
  session.dispose();
  rmSync(root, { recursive: true, force: true });
}
