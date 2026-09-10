import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  collectReferences,
  stripReferenceBodies,
} from "../../extensions/lib/compaction-references.ts";
import { CHECKPOINT_TYPE } from "../../extensions/lib/compaction-checkpoint.ts";
import { formatAgentsBlock } from "../../extensions/lib/agents.ts";

export function project_result(path: string, content: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "cwd-call",
    toolName: "set_cwd",
    isError: false,
    timestamp: Date.now(),
    content: [
      {
        type: "text" as const,
        text: `changed cwd${formatAgentsBlock([{ path, content }])}`,
      },
    ],
    details: { referenceDocuments: [{ kind: "project", path }] },
  };
}

let clock = Date.now() - 100_000;
export const contains = (value: unknown, needle: string) =>
  assert(JSON.stringify(value).includes(needle), needle);
export const absent = (value: unknown, needle: string) =>
  assert(!JSON.stringify(value).includes(needle), needle);
export function file(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}
export function user(manager: SessionManager, content: string) {
  return manager.appendMessage({ role: "user", content, timestamp: ++clock });
}
export function skill(
  manager: SessionManager,
  path: string,
  body: string,
  options: {
    name?: string;
    subdoc?: string;
    failed?: boolean;
    available?: string[];
  } = {},
) {
  const id = `call-${++clock}`;
  const name = options.name ?? "fixture";
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "skill",
        arguments: {
          name,
          ...(options.subdoc ? { subdoc: options.subdoc } : {}),
        },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1",
    stopReason: "toolUse",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: ++clock,
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "skill",
    content: [{ type: "text", text: body }],
    details: {
      name,
      path,
      ...(options.subdoc ? { subdoc: options.subdoc } : {}),
      ...(options.available ? { available: options.available } : {}),
    },
    isError: !!options.failed,
    timestamp: ++clock,
  });
  return id;
}
export function pairing(
  messages: ReturnType<SessionManager["buildSessionContext"]>["messages"],
) {
  return messages.flatMap((message) => {
    if (message.role === "assistant")
      return message.content.flatMap((block) =>
        block.type === "toolCall" ? [`call:${block.id}`] : [],
      );
    return message.role === "toolResult"
      ? [`result:${message.toolCallId}`]
      : [];
  });
}
export function blocks(
  messages: ReturnType<SessionManager["buildSessionContext"]>["messages"],
) {
  return messages.filter(
    (message) =>
      message.role === "custom" && message.customType === CHECKPOINT_TYPE,
  );
}

export async function native_skill_recovery(root: string) {
  const manager = SessionManager.inMemory(root);
  const path = file(`${root}/native/SKILL.md`, "CURRENT_NATIVE_DOCUMENT");
  const expanded = `<skill name="native" location="${path}">\nReferences are relative to ${root}/native.\n\nOLD_NATIVE_DOCUMENT\n</skill>\n\nDo not use subagents; continue the requested fix.`;
  user(manager, expanded);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: expanded }],
    timestamp: ++clock,
  });
  const references = await collectReferences(manager.getBranch(), {
    cwd: root,
    systemFiles: [],
    trusted: false,
  });
  assert.equal(references.documents.length, 1);
  assert.equal(references.documents[0].content, "CURRENT_NATIVE_DOCUMENT");
  const original = manager.buildSessionContext().messages;
  const filtered = stripReferenceBodies(original, references.documents);
  absent(filtered, "OLD_NATIVE_DOCUMENT");
  contains(filtered, "Do not use subagents; continue the requested fix.");
  contains(original, "OLD_NATIVE_DOCUMENT");
}
