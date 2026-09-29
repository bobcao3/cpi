import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  formatDimensionNote,
  resizeImage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadText, render, renderLines, textPath } from "../lib/text.ts";

interface CaptureText {
  tool: { description: string; prompt_snippet: string; guidelines: string[] };
  schema: { id: string; font_size: string };
  results: Record<string, string>;
}

const TOOL = "sh_screenshot";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function registerTerminalCaptureTool(
  pi: ExtensionAPI,
  captureSessionScreenshot: (
    id: string,
    path: string,
    fontSize?: number,
    signal?: AbortSignal,
  ) => Promise<{ uid: string }>,
): void {
  const text = loadText<CaptureText>(
    "terminal-capture",
    textPath("terminal-capture"),
  );
  let vision: boolean | undefined;
  const sync = (ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    const enabled = ctx.model?.input.includes("image") === true;
    if (enabled === vision) return;
    vision = enabled;
    if (enabled && !active.includes(TOOL)) pi.setActiveTools([...active, TOOL]);
    if (!enabled && active.includes(TOOL))
      pi.setActiveTools(active.filter((name) => name !== TOOL));
  };
  pi.registerTool({
    name: TOOL,
    label: TOOL,
    description: text.tool.description,
    promptSnippet: text.tool.prompt_snippet,
    promptGuidelines: renderLines(text.tool.guidelines, {}),
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: text.schema.id }),
      font_size: Type.Optional(
        Type.Integer({
          minimum: 6,
          maximum: 96,
          description: text.schema.font_size,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.model?.input.includes("image"))
        throw new Error(text.results.non_vision);
      signal?.throwIfAborted();
      const directory = await mkdtemp(join(tmpdir(), "cpi-sh-screen-"));
      try {
        const path = join(directory, "screen.png");
        const target = await captureSessionScreenshot(
          params.id,
          path,
          params.font_size,
          signal,
        );
        signal?.throwIfAborted();
        if ((await stat(path)).size > MAX_IMAGE_BYTES)
          throw new Error(text.results.image_too_large);
        const image = await resizeImage(
          await readFile(path),
          "image/png",
          ctx.model.inputLimits?.images?.resize,
        );
        signal?.throwIfAborted();
        if (!image) throw new Error(text.results.image_failed);
        const note = [
          render(text.results.complete, { id: params.id, uid: target.uid }),
          formatDimensionNote(image),
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [
            { type: "text" as const, text: note },
            {
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            },
          ],
          details: {
            id: params.id,
            uid: target.uid,
            width: image.width,
            height: image.height,
          },
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
  pi.on("session_start", (_event, ctx) => sync(ctx));
  pi.on("model_select", (_event, ctx) => sync(ctx));
  pi.on("before_agent_start", (_event, ctx) => sync(ctx));
}
