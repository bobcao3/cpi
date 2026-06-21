/**
 * read-media — vision-gated image reader.
 *
 * cpi disables the built-in `read`/`write`/`edit` tools (see
 * disable-read-write-edit.ts) in favor of `llm_editor`. But `llm_editor`
 * only handles text; the image-reading path that lived in the built-in `read`
 * tool is lost. read-media restores it as a dedicated, single-purpose tool:
 * read an image file and return it as an inline `ImageContent` attachment,
 * leveraging pi's own image pipeline (`resizeImage` + `formatDimensionNote`)
 * so the model receives the same resized/encoded payload the built-in `read`
 * tool produced.
 *
 * Gating: the tool is registered unconditionally at load (idempotent
 * `Map.set`), but only added to the *active* tool set when the selected
 * model supports vision (`model.input` includes `"image"`). Reconciled on
 * session_start / resources_discover / model_select, mirroring
 * disable-read-write-edit's approach — no `globalThis` dedup flag (the
 * anti-pattern); we always recompute from real model + active-tool state.
 *
 * Video: pi-ai's content model has only `TextContent | ImageContent` and the
 * model registry exposes no video capability, so native video inline is
 * impossible through pi today. We detect video and return an actionable note
 * (extract frames via bash) rather than silently dropping the file.
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  formatDimensionNote,
  resizeImage,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
  detectImageMimeTypeFromFile,
  displayPath,
  isVideoPath,
  resolveMediaPath,
} from "./lib/media.ts";

const TOOL = "read_media";

interface MediaDetails {
  path?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  note: string;
}

const schema = Type.Object({
  path: Type.String({
    description: "Path to the image file to read (relative or absolute, ~ expanded)",
  }),
});

function textResult(note: string, details: MediaDetails): AgentToolResult<MediaDetails> {
  return { content: [{ type: "text", text: note }], details };
}

function aborted(): Error {
  return new Error("Operation aborted");
}

function modelSupportsVision(model: Model<any> | undefined): boolean {
  return model?.input.includes("image") ?? false;
}

/** Add/remove read_media from the active set to match the current model. */
function reconcileActive(pi: ExtensionAPI, model: Model<any> | undefined): void {
  const active = pi.getActiveTools();
  const has = active.includes(TOOL);
  const want = modelSupportsVision(model);
  if (has === want) return;
  const next = want ? [...active, TOOL] : active.filter((n) => n !== TOOL);
  pi.setActiveTools(next);
}

export default function readMediaExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL,
    label: "read-media",
    description:
      "Read an image file (jpg, png, gif, webp) and return it as an inline image attachment for the model to view. Only available when the current model supports vision. Video files cannot be inlined; extract frames via bash (ffmpeg) and read those instead.",
    promptSnippet: "Read image files inline",
    promptGuidelines: [
      "Use read_media to view image files (jpg, png, gif, webp); do not cat/sed/base64 them.",
      "read_media is vision-gated: if it is unavailable the current model cannot see images.",
      "For video, extract frames with ffmpeg via bash, then read_media the frames.",
    ],
    parameters: schema,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<MediaDetails>> {
      if (signal?.aborted) throw aborted();
      const model = ctx.model;
      // Defense in depth: the tool is gated out of the active set for
      // non-vision models, but a resumed session or a model switch mid-turn
      // could still reach here. Refuse rather than emit an unreadable image.
      if (!model?.input?.includes("image")) {
        return textResult(
          "read_media is disabled: the current model does not support images.",
          { note: "non-vision model" },
        );
      }

      const rawPath = params.path;
      const absolutePath = resolveMediaPath(rawPath, ctx.cwd);
      await access(absolutePath, constants.R_OK);
      if (signal?.aborted) throw aborted();

      if (isVideoPath(absolutePath)) {
        const note =
          `Video file [${basename(absolutePath)}]. pi has no native video content type, ` +
          `so it cannot be inlined. Extract frames via bash, e.g. ` +
          `\`ffmpeg -i "${rawPath}" -vf fps=1 frame_%03d.png\`, then read_media the frames.`;
        return textResult(note, { note, path: absolutePath });
      }

      const mimeType = await detectImageMimeTypeFromFile(absolutePath);
      if (!mimeType) {
        return textResult(
          `Not a supported image type (jpg, png, gif, webp): ${displayPath(absolutePath, ctx.cwd)}`,
          { note: "unsupported image type", path: absolutePath },
        );
      }

      const buffer = await readFile(absolutePath);
      if (signal?.aborted) throw aborted();

      const resized = await resizeImage(buffer, mimeType);
      if (!resized) {
        return textResult(
          `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
          { note: "resize failed", path: absolutePath, mimeType },
        );
      }

      const dimNote = formatDimensionNote(resized);
      let note = `Read image file [${resized.mimeType}]`;
      if (dimNote) note += `\n${dimNote}`;

      if (signal?.aborted) throw aborted();

      return {
        content: [
          { type: "text", text: note } satisfies TextContent,
          { type: "image", data: resized.data, mimeType: resized.mimeType } satisfies ImageContent,
        ],
        details: {
          path: absolutePath,
          mimeType: resized.mimeType,
          width: resized.width,
          height: resized.height,
          note,
        },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      const rawPath = (args?.path as string | undefined) ?? "";
      const absolutePath = rawPath ? resolveMediaPath(rawPath, context.cwd) : "";
      const shown = absolutePath ? displayPath(absolutePath, context.cwd) : rawPath;
      text.setText(theme.fg("toolTitle", theme.bold("read-media")) + " " + theme.fg("accent", shown));
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      text.setText(renderMediaResult(result, context.showImages, theme));
      return text;
    },
  });

  // Reconcile active-tool membership on the same lifecycle hooks
  // disable-read-write-edit uses, plus model_select so a mid-session switch
  // to/from a vision model updates the tool set immediately.
  pi.on("session_start", async (_e, ctx) => reconcileActive(pi, ctx.model));
  pi.on("resources_discover", async (_e, ctx) => reconcileActive(pi, ctx.model));
  pi.on("model_select", async (e) => reconcileActive(pi, e.model));
}

/** Mirror pi's getTextOutput: text blocks, plus image fallbacks when the
 * terminal can't (or user chose not to) render inline images. */
function renderMediaResult(
  result: AgentToolResult<MediaDetails> | undefined,
  showImages: boolean,
  theme: Theme,
): string {
  if (!result) return "";
  const textBlocks = result.content.filter((c) => c.type === "text");
  const imageBlocks = result.content.filter((c) => c.type === "image");
  let output = textBlocks.map((c) => (c as TextContent).text ?? "").join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const indicators = imageBlocks
      .map((img) => {
        const ic = img as ImageContent;
        const dims = ic.data && ic.mimeType ? (getImageDimensions(ic.data, ic.mimeType) ?? undefined) : undefined;
        return imageFallback(ic.mimeType ?? "image/unknown", dims);
      })
      .join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  return theme.fg("toolOutput", output);
}
