import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI } from "./lib/tree-api.ts";
import { captureSessionOwner, type SessionOwner } from "./lib/storage/owner.ts";
import {
  create_temp_directory,
  inventory_temp_directories,
  release_temp_directory_by_path,
  type ManagedDirectory,
} from "./lib/storage/temp-dirs.ts";
import { loadText, render, renderLines, textPath } from "./lib/text.ts";

interface TempDirectoryText {
  tool: { label: string; description: string; prompt_snippet: string };
  schema: Record<string, string>;
  guidelines: { bullets: string[] };
  results: Record<string, string>;
}

type TempDirectory = Omit<ManagedDirectory, "id">;

interface InventoryResult {
  owner: SessionOwner | null;
  inventory_complete: boolean;
  directories: TempDirectory[] | null;
  inventory_errors: string[];
  created?: TempDirectory;
  released?: string;
  error?: string;
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function model_directory(directory: ManagedDirectory): TempDirectory {
  const { path, type, lifecycle, created_at, purpose, owner } = directory;
  return { path, type, lifecycle, created_at, purpose, owner };
}

async function inventory(
  owner: SessionOwner,
  text: TempDirectoryText,
): Promise<InventoryResult> {
  try {
    const current = await inventory_temp_directories(owner);
    return {
      owner,
      inventory_complete: current.inventory_errors.length === 0,
      directories: current.directories.map(model_directory),
      inventory_errors: current.inventory_errors,
    };
  } catch (error) {
    return {
      owner,
      inventory_complete: false,
      directories: null,
      inventory_errors: [
        render(text.results.inventory_failed, { error: error_message(error) }),
      ],
    };
  }
}

function tool_result(data: InventoryResult, text: TempDirectoryText) {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [
      { type: "text" as const, text: render(text.results.inventory, { json }) },
    ],
    structuredContent: JSON.parse(json) as JsonValue,
    details: data,
    isError: data.error !== undefined || !data.inventory_complete,
  };
}

export default function temp_dir(pi: ExtensionAPI): void {
  const text = loadText<TempDirectoryText>("temp-dir", textPath("temp-dir"));
  const directory_type = Type.Union([
    Type.Literal("scratch"),
    Type.Literal("retained"),
  ]);
  const parameters = Type.Object(
    {
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("inventory"),
          Type.Literal("release"),
        ],
        { description: text.schema.action },
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("scratch"), Type.Literal("retained")], {
          description: text.schema.type,
          default: "scratch",
        }),
      ),
      purpose: Type.String({
        description: text.schema.purpose,
        pattern: "^[a-z][a-z0-9-]{0,63}$",
      }),
      path: Type.Optional(
        Type.String({ description: text.schema.path, minLength: 1 }),
      ),
      confirm_all_writers_stopped: Type.Optional(
        Type.Literal(true, {
          description: text.schema.confirm_all_writers_stopped,
        }),
      ),
    },
    { additionalProperties: false },
  );
  const directory = Type.Object(
    {
      path: Type.String(),
      type: directory_type,
      lifecycle: Type.Union([
        Type.Literal("session-cleanup"),
        Type.Literal("explicit-release"),
      ]),
      created_at: Type.String(),
    },
    { additionalProperties: true },
  );
  const output_schema = Type.Object({
    owner: Type.Union([
      Type.Object({
        session_id: Type.String(),
        session_dir: Type.String(),
      }),
      Type.Null(),
    ]),
    inventory_complete: Type.Boolean({
      description: text.schema.inventory_complete,
    }),
    directories: Type.Union([Type.Array(directory), Type.Null()], {
      description: text.schema.directories,
    }),
    inventory_errors: Type.Array(Type.String(), {
      description: text.schema.inventory_errors,
    }),
    created: Type.Optional(directory),
    released: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  });

  pi.registerTool({
    name: "temp_dir",
    label: text.tool.label,
    description: render(text.tool.description, {}),
    promptSnippet: text.tool.prompt_snippet,
    promptGuidelines: renderLines(text.guidelines.bullets, {}),
    parameters,
    outputSchema: output_schema,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      let owner: SessionOwner;
      try {
        owner = captureSessionOwner(
          ctx.sessionManager,
          join(getAgentDir(), "jobs"),
        );
      } catch (error) {
        const message = render(text.results.owner_failed, {
          error: error_message(error),
        });
        return tool_result(
          {
            owner: null,
            inventory_complete: false,
            directories: null,
            inventory_errors: [message],
            error: message,
          },
          text,
        );
      }
      let created: TempDirectory | undefined;
      let released: string | undefined;
      let failure: string | undefined;
      try {
        if (signal?.aborted) throw new Error(text.results.aborted);
        if (params.action === "create") {
          created = model_directory(
            await create_temp_directory(
              owner,
              params.type ?? "scratch",
              params.purpose,
            ),
          );
        } else if (params.action === "release") {
          if (!params.path || params.confirm_all_writers_stopped !== true)
            throw new Error(text.results.release_requires_writers);
          await release_temp_directory_by_path(owner, params.path);
          released = params.path;
        } else if (params.action !== "inventory") {
          throw new Error(text.results.invalid_action);
        }
      } catch (error) {
        failure = error_message(error);
      }
      const current = await inventory(owner, text);
      return tool_result(
        { ...current, created, released, error: failure },
        text,
      );
    },
  });
}
