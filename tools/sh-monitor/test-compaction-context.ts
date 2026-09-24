import {
  contains,
  absent,
  file,
  user,
  skill,
  pairing,
  blocks,
  project_result,
  native_skill_recovery,
} from "./test-compaction-fixtures.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  collectReferences,
  stripReferenceBodies,
} from "../../extensions/lib/compaction-references.ts";
import {
  buildCheckpoint,
  projectCheckpoint,
} from "../../extensions/lib/compaction-checkpoint.ts";
import { surfaceNewAgents } from "../../extensions/lib/agents.ts";
import type { RuntimeSnapshot } from "../../extensions/lib/compaction-state.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-compaction-context-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project", "nested");
mkdirSync(agentDir);
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT = "1";
process.env.CPI_FORK_PROBE = "1";
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] =
  [];
const errors: string[] = [];
const runtime = await ModelRuntime.create({
  modelsPath: join(agentDir, "models.json"),
  authPath: join(agentDir, "auth.json"),
});
const model = runtime.getModel("openai", "gpt-4.1");
assert(model, "real built-in model catalogue must contain openai/gpt-4.1");
async function open(manager: SessionManager) {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      resolve("extensions/lib/compaction.ts"),
      resolve("extensions/lib/model-context.ts"),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime: runtime,
    model,
    noTools: "all",
  });
  sessions.push(session);
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error.error),
  });
  assert(session.extensionRunner.hasHandlers("session_before_compact"));
  assert(session.extensionRunner.hasHandlers("context"));
  return session;
}

try {
  await native_skill_recovery(root);
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  manager.appendModelChange(model.provider, model.id);
  manager.appendCustomEntry("cpi-model-origin", {
    provider: "openai",
    modelId: "gpt-4o",
  });
  const rewind = user(manager, "before any reference loads");
  const main = file(
    join(root, "skills", "fixture", "SKILL.md"),
    "MAIN_CURRENT_BODY",
  );
  const subdoc = file(
    join(root, "skills", "fixture", "usage.md"),
    "SUBDOC_CURRENT_BODY",
  );
  const deleted = file(join(root, "skills", "deleted.md"), "DELETED_BODY");
  const failed = file(
    join(root, "skills", "failed.md"),
    "MUST_NOT_RESTORE_FAILED",
  );
  const alias = join(root, "skills", "fixture", "alias.md");
  symlinkSync(main, alias);
  skill(manager, main, "MAIN_OLD_HISTORY_BODY");
  skill(manager, alias, "MAIN_ALIAS_HISTORY_BODY");
  skill(manager, deleted, "DELETED_BODY");
  rmSync(deleted);
  skill(manager, failed, "failed load diagnostic", { failed: true });
  skill(manager, failed, "available skills listing", {
    available: ["fixture"],
  });
  const keep = user(manager, "retained pre-compaction user");
  const retainedCall = skill(manager, subdoc, "SUBDOC_OLD_RETAINED_BODY", {
    subdoc: "usage.md",
  });
  const systemDoc = file(join(root, "AGENTS.md"), "SYSTEM_ALREADY_PRESENT");
  const projectDoc = file(
    join(root, "project", "AGENTS.md"),
    "CURRENT_PROJECT_BODY",
  );
  const currentDoc = file(join(cwd, "CLAUDE.md"), "CURRENT_NESTED_BODY");
  surfaceNewAgents(cwd);
  assert.deepEqual(
    surfaceNewAgents(cwd),
    [],
    "project discovery must really be marked seen",
  );
  const options = { cwd, systemFiles: [systemDoc], trusted: true };
  const refs = await collectReferences(manager.getBranch(), options);
  assert.deepEqual(
    refs.documents.map((doc) => doc.path).sort(),
    [projectDoc, currentDoc].sort(),
  );
  assert.equal(
    new Set(refs.documents.map((doc) => doc.path)).size,
    refs.documents.length,
  );
  absent(refs.documents, "MAIN_CURRENT_BODY");
  absent(refs.documents, "SUBDOC_CURRENT_BODY");
  assert(!refs.warnings.some((warning) => warning.includes(deleted)));
  absent(refs, "MUST_NOT_RESTORE_FAILED");
  assert.deepEqual(
    (
      await collectReferences(manager.getBranch(), {
        ...options,
        trusted: false,
      })
    ).documents
      .map((doc) => doc.path)
      .sort(),
    [],
  );
  const history = manager.getBranch().flatMap(sessionEntryToContextMessages);
  const historyCopy = structuredClone(history);
  const stripped = stripReferenceBodies(history, refs.documents, true);
  assert.deepEqual(
    history,
    historyCopy,
    "stripping must not mutate the transcript",
  );
  assert.deepEqual(pairing(stripped), pairing(history));
  for (const body of [
    "MAIN_OLD_HISTORY_BODY",
    "MAIN_ALIAS_HISTORY_BODY",
    "SUBDOC_OLD_RETAINED_BODY",
    "DELETED_BODY",
  ])
    absent(stripped, body);
  for (const path of [main, alias, subdoc, deleted]) contains(stripped, path);
  contains(stripped, "failed load diagnostic");
  contains(
    stripReferenceBodies(history, refs.documents),
    "SUBDOC_OLD_RETAINED_BODY",
  );
  const projectResult = project_result(projectDoc, "OLD_PROJECT_TOOL_BODY");
  const projectStripped = stripReferenceBodies([projectResult], refs.documents);
  absent(projectStripped, "OLD_PROJECT_TOOL_BODY");
  contains(projectStripped, "changed cwd");
  contains(projectStripped, projectDoc);
  const hugeCwd = join(root, "huge-project");
  file(join(hugeCwd, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
  const limits = SessionManager.inMemory(cwd);
  user(limits, "limit fixture");
  await assert.rejects(
    collectReferences(limits.getBranch(), { ...options, cwd: hugeCwd }),
    /128|limit|exceed/i,
  );
  const state: RuntimeSnapshot = {
    cwd,
    model: { provider: model.provider, modelId: model.id },
    alarms: [],
    shells: [],
    repeats: [],
    subagents: [],
    environments: [],
  };
  const checkpoint = buildCheckpoint(refs, state);
  assert.equal(checkpoint.version, 1);
  contains(checkpoint.content, "CURRENT_PROJECT_BODY");
  contains(checkpoint.content, "CURRENT_NESTED_BODY");
  absent(checkpoint.content, "MAIN_CURRENT_BODY");
  absent(checkpoint.content, "SUBDOC_CURRENT_BODY");
  absent(checkpoint.content, deleted);
  absent(checkpoint.content, "SYSTEM_ALREADY_PRESENT");
  assert.throws(
    () =>
      buildCheckpoint(
        {
          documents: [
            { kind: "project", path: main, content: "x".repeat(768 * 1024) },
          ],
          warnings: [],
        },
        state,
      ),
    /768/,
  );
  const checkpointId = manager.appendCompaction(
    "fixture task summary, not a model-generated summary",
    keep,
    1000,
    { cpiContext: checkpoint },
  );
  const after = user(manager, "subsequent user after checkpoint");
  skill(manager, main, "NEW_FULL_SKILL_RESULT_AFTER_CHECKPOINT");
  const session = await open(manager);
  const raw = manager.buildSessionContext().messages;
  const ctx = session.extensionRunner.createContext();
  assert.equal(ctx.sessionManager.getSessionId(), manager.getSessionId());
  const projected = projectCheckpoint(raw, ctx);
  const emitted = await session.extensionRunner.emitContext(raw);
  assert.deepEqual(
    emitted,
    projected,
    "current checkpoint model suppresses stale-origin fallback",
  );
  assert.equal(blocks(emitted).length, 1);
  const block = blocks(emitted)[0];
  assert.equal(block.role === "custom" && block.content, checkpoint.content);
  assert.equal(
    block.role === "custom" &&
      (block.details as { checkpointId: string }).checkpointId,
    checkpointId,
  );
  const index = emitted.indexOf(block);
  assert(
    emitted.findIndex(
      (message) =>
        message.role === "toolResult" && message.toolCallId === retainedCall,
    ) < index,
  );
  assert(
    emitted.findIndex(
      (message) =>
        message.role === "user" &&
        message.content === "subsequent user after checkpoint",
    ) > index,
  );
  contains(emitted, "SUBDOC_OLD_RETAINED_BODY");
  contains(emitted.at(-1), "NEW_FULL_SKILL_RESULT_AFTER_CHECKPOINT");
  assert.deepEqual(pairing(emitted), pairing(raw));
  assert.deepEqual(await session.extensionRunner.emitContext(raw), emitted);
  assert.deepEqual(
    await session.extensionRunner.emitContext(emitted),
    emitted,
    "projection is idempotent even on projected input",
  );
  absent(stripReferenceBodies(emitted, refs.documents), checkpoint.content);
  const sessionFile = manager.getSessionFile();
  assert(sessionFile);
  const resumedManager = SessionManager.open(sessionFile);
  const resumed = await open(resumedManager);
  assert.deepEqual(
    await resumed.extensionRunner.emitContext(
      resumedManager.buildSessionContext().messages,
    ),
    emitted,
    "checkpoint details survive disk resume",
  );
  await resumed.reload();
  assert.deepEqual(
    await resumed.extensionRunner.emitContext(
      resumedManager.buildSessionContext().messages,
    ),
    emitted,
    "registration survives extension reload",
  );
  const second = buildCheckpoint(
    await collectReferences(manager.getBranch(), options),
    { ...state, cwd: `${cwd}/second-snapshot` },
  );
  manager.appendCompaction("second fixture task summary", after, 2000, {
    cpiContext: second,
  });
  user(manager, "after second checkpoint");
  const twice = await session.extensionRunner.emitContext(
    manager.buildSessionContext().messages,
  );
  assert.equal(blocks(twice).length, 1);
  const secondBlock = blocks(twice)[0];
  assert.equal(
    secondBlock.role === "custom" && secondBlock.content,
    second.content,
  );
  absent(twice, "fixture task summary, not a model-generated summary");
  contains(twice, "NEW_FULL_SKILL_RESULT_AFTER_CHECKPOINT");
  assert.deepEqual(await session.extensionRunner.emitContext(twice), twice);
  manager.branch(checkpointId);
  const mismatch = buildCheckpoint(refs, {
    ...state,
    model: { provider: "openai", modelId: "gpt-4o" },
  });
  manager.appendCompaction("mismatch fixture summary", keep, 1000, {
    cpiContext: mismatch,
  });
  const mismatched = await session.extensionRunner.emitContext(
    manager.buildSessionContext().messages,
  );
  const notices = mismatched.filter(
    (message) =>
      message.role === "custom" &&
      (message.details as { kind?: string })?.kind === "model-change",
  );
  assert.equal(notices.length, 1);
  contains(notices, "openai/gpt-4.1");
  contains(notices, "openai/gpt-4o");
  assert(
    mismatched.indexOf(notices[0]) > mismatched.indexOf(blocks(mismatched)[0]),
  );
  manager.branch(rewind);
  const rewound = await session.extensionRunner.emitContext(
    manager.buildSessionContext().messages,
  );
  assert.equal(blocks(rewound).length, 0);
  absent(rewound, "MAIN_CURRENT_BODY");
  manager.branch(checkpointId);
  assert.equal(
    blocks(
      await session.extensionRunner.emitContext(
        manager.buildSessionContext().messages,
      ),
    ).length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    "compaction context integration: project references, skill stripping, limits, persisted projection, reload, rewind, model context passed",
  );
} finally {
  for (const session of sessions) session.dispose();
  rmSync(root, { recursive: true, force: true });
}
