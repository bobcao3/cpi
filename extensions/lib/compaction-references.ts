import type { SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { discoverAgentsPaths } from "./agents.ts";
import { loadText, render, textPath } from "./text.ts";

type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

export interface ReferenceDocument {
  kind: "project";
  path: string;
  content: string;
}

export interface ReferenceBundle {
  documents: ReferenceDocument[];
  warnings: string[];
}

type ReferenceMetadata =
  | Omit<ReferenceDocument, "content">
  | { kind: "skill"; path: string; name: string; subdoc?: string };
type ReferenceText = {
  marker: { managed: string; unavailable: string; skill: string };
  warning: { missing: string; limit: string; not_file: string };
  limits: { document: string; count: string; total: string };
  syntax: { project_header: string; project_end: string };
};
const reference_text = loadText<ReferenceText>(
  "compaction-references",
  textPath("compaction-references"),
);
const max_documents = 64;
const max_document_bytes = 128 * 1024;
const max_total_bytes = 512 * 1024;

function canonical_path(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function native_skill(message: AgentMessage) {
  if (message.role !== "user") return undefined;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.find((block) => block.type === "text")?.text;
  return text?.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>([\s\S]*)$/,
  );
}

function result_references(message: AgentMessage): ReferenceMetadata[] {
  const native = native_skill(message);
  if (native && isAbsolute(native[2]))
    return [{ kind: "skill", name: native[1], path: native[2] }];
  // Existing sessions may contain results from the removed cpi skill tool.
  if (message.role !== "toolResult" || message.isError) return [];
  if (message.toolName !== "skill" && message.toolName !== "set_cwd") return [];
  const details = message.details as Record<string, unknown> | undefined;
  if (!details || details.available !== undefined) return [];
  const expected_kind = message.toolName === "skill" ? "skill" : "project";
  if (Array.isArray(details.referenceDocuments)) {
    return details.referenceDocuments.filter(
      (item): item is ReferenceMetadata =>
        item !== null &&
        typeof item === "object" &&
        item.kind === expected_kind &&
        typeof item.path === "string" &&
        isAbsolute(item.path) &&
        (expected_kind !== "skill" || typeof item.name === "string") &&
        (item.subdoc === undefined || typeof item.subdoc === "string"),
    );
  }
  if (
    expected_kind === "skill" &&
    typeof details.name === "string" &&
    typeof details.path === "string" &&
    isAbsolute(details.path)
  ) {
    return [
      {
        kind: "skill",
        name: details.name,
        path: details.path,
        subdoc:
          typeof details.subdoc === "string"
            ? details.subdoc.trim() || undefined
            : undefined,
      },
    ];
  }
  if (expected_kind === "project" && Array.isArray(details.newAgentsFiles)) {
    return details.newAgentsFiles
      .filter(
        (path): path is string => typeof path === "string" && isAbsolute(path),
      )
      .map((path) => ({ kind: "project", path }));
  }
  return [];
}

function limit_error(path: string, limit: string): never {
  throw new Error(render(reference_text.warning.limit, { path, limit }));
}

export async function collectReferences(
  branch: readonly SessionEntry[],
  options: { cwd: string; systemFiles: readonly string[]; trusted: boolean },
): Promise<ReferenceBundle> {
  const documents: ReferenceDocument[] = [];
  const warnings: string[] = [];
  const historical_projects = new Set<string>();
  const contents = new Map<string, string | undefined>();
  const charged = new Set<string>();
  let total_bytes = 0;
  const warn = (path: string, reason: string) => {
    warnings.push(render(reference_text.warning.missing, { path, reason }));
  };
  function check_bytes(path: string, bytes: number): void {
    if (bytes > max_document_bytes)
      limit_error(path, reference_text.limits.document);
    if (total_bytes + bytes > max_total_bytes)
      limit_error(path, reference_text.limits.total);
  }
  function bounded_read(source: string): string | undefined {
    const path = canonical_path(source);
    if (!contents.has(path)) {
      contents.set(path, undefined);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) {
          warn(path, reference_text.warning.not_file);
          return undefined;
        }
        check_bytes(path, stat.size);
        const buffer = Buffer.alloc(
          Math.min(max_document_bytes, max_total_bytes - total_bytes) + 1,
        );
        let bytes = 0;
        while (bytes < buffer.length) {
          const count = readSync(
            descriptor,
            buffer,
            bytes,
            buffer.length - bytes,
            null,
          );
          if (count === 0) break;
          bytes += count;
        }
        check_bytes(path, bytes);
        contents.set(path, buffer.toString("utf8", 0, bytes));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code) throw error;
        warn(path, code);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    const content = contents.get(path);
    if (content === undefined) return undefined;
    if (!charged.has(path)) {
      if (charged.size >= max_documents)
        limit_error(path, reference_text.limits.count);
      const bytes = Buffer.byteLength(content);
      check_bytes(path, bytes);
      total_bytes += bytes;
      charged.add(path);
    }
    return content;
  }
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    for (const reference of result_references(entry.message)) {
      if (reference.kind === "project") {
        historical_projects.add(reference.path);
      }
    }
  }
  if (options.trusted) {
    const system_paths = new Set(options.systemFiles.map(canonical_path));
    for (const source of discoverAgentsPaths(options.cwd)) {
      const path = canonical_path(source);
      if (
        system_paths.has(path) ||
        documents.some((document) => document.path === path)
      )
        continue;
      const content = bounded_read(path);
      if (content !== undefined)
        documents.push({ kind: "project", path, content });
    }
    for (const path of historical_projects) {
      const descendant = relative(dirname(path), resolve(options.cwd));
      if (
        descendant === ".." ||
        descendant.startsWith(`..${sep}`) ||
        isAbsolute(descendant) ||
        system_paths.has(canonical_path(path))
      )
        continue;
      try {
        if (!statSync(path).isFile())
          warn(path, reference_text.warning.not_file);
        accessSync(path, constants.R_OK);
      } catch (error) {
        warn(path, (error as NodeJS.ErrnoException).code ?? "UNKNOWN");
      }
    }
  }
  if (documents.length > max_documents)
    limit_error(options.cwd, reference_text.limits.count);
  if (
    documents.reduce(
      (bytes, document) => bytes + Buffer.byteLength(document.content),
      0,
    ) > max_total_bytes
  ) {
    limit_error(options.cwd, reference_text.limits.total);
  }
  return { documents, warnings: [...new Set(warnings)] };
}

export function stripReferenceBodies(
  messages: AgentMessage[],
  documents: readonly Pick<ReferenceDocument, "path">[],
  stripSkills = false,
  skills: readonly Skill[] = [],
): AgentMessage[] {
  const managed_paths = new Set(
    documents.map((document) => canonical_path(document.path)),
  );
  const skill_paths = skills.map((skill) => ({
    name: skill.name,
    file: canonical_path(skill.filePath),
    dir: canonical_path(skill.baseDir),
  }));
  const read_calls = new Map<string, string>();
  function marker(reference: ReferenceMetadata): string {
    return render(
      reference.kind === "skill"
        ? reference_text.marker.skill
        : managed_paths.has(canonical_path(reference.path))
          ? reference_text.marker.managed
          : reference_text.marker.unavailable,
      reference,
    );
  }
  return messages.flatMap((message): AgentMessage[] => {
    if (
      message.role === "custom" &&
      message.customType === "cpi-context-checkpoint"
    )
      return [];
    if (stripSkills && message.role === "assistant") {
      for (const block of message.content) {
        if (
          block.type === "toolCall" &&
          block.name === "read" &&
          typeof block.arguments?.path === "string" &&
          isAbsolute(block.arguments.path)
        )
          read_calls.set(block.id, block.arguments.path);
      }
    }
    const references = result_references(message);
    const native = native_skill(message);
    if (message.role === "user" && native && references.length) {
      if (!stripSkills) return [message];
      const replacement = marker(references[0]) + native[3];
      return [
        {
          ...message,
          content:
            typeof message.content === "string"
              ? replacement
              : message.content.map((block) =>
                  block.type === "text" && block.text === native[0]
                    ? { ...block, text: replacement }
                    : block,
                ),
        } as AgentMessage,
      ];
    }
    if (message.role !== "toolResult" || references.length === 0) {
      if (
        stripSkills &&
        message.role === "toolResult" &&
        message.toolName === "read" &&
        !message.isError
      ) {
        const details = message.details as { path?: unknown } | undefined;
        const path =
          typeof details?.path === "string"
            ? details.path
            : read_calls.get(message.toolCallId);
        if (path && isAbsolute(path)) {
          const file = canonical_path(path);
          const skill = skill_paths.find(
            (item) =>
              file === item.file || file.startsWith(`${item.dir}${sep}`),
          );
          if (skill)
            return [
              {
                ...message,
                content: [
                  {
                    type: "text",
                    text: marker({
                      kind: "skill",
                      name: skill.name,
                      path: file,
                    }),
                  },
                ],
              },
            ];
        }
      }
      return [message];
    }
    if (message.toolName === "skill") {
      if (!stripSkills) return [message];
      return [
        {
          ...message,
          content: [{ type: "text", text: references.map(marker).join("\n") }],
        },
      ];
    }
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      let text = block.text;
      const locations = references
        .map((reference) => ({
          reference,
          start: text.indexOf(
            render(reference_text.syntax.project_header, reference),
          ),
        }))
        .filter((location) => location.start >= 0)
        .sort((left, right) => left.start - right.start);
      for (let index = locations.length - 1; index >= 0; index--) {
        const location = locations[index];
        const end = text.lastIndexOf(
          reference_text.syntax.project_end,
          locations[index + 1]?.start !== undefined
            ? locations[index + 1].start - 1
            : text.length,
        );
        if (end <= location.start) continue;
        text =
          text.slice(0, location.start) +
          "\n" +
          marker(location.reference) +
          text.slice(end + reference_text.syntax.project_end.length);
      }
      return text === block.text ? block : { ...block, text };
    });
    return [{ ...message, content }];
  });
}
