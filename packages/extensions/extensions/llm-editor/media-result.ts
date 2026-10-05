import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  resizeImage,
  formatDimensionNote,
} from "@earendil-works/pi-coding-agent";
import { loadEditorText, fmt } from "./text.ts";

export function textResult(
  id: string,
  kind: string,
  text: string,
  details?: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { id, kind, ...details },
  };
}

export async function readImageResult(abs: string, mime: string, id: string) {
  const T = loadEditorText();
  let buffer = await readFile(abs);
  if (mime === "image/avif") {
    buffer = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .timeout({ seconds: 15 })
      .webp({ lossless: true })
      .toBuffer();
    mime = "image/webp";
  }
  const resized = await resizeImage(buffer, mime);
  if (!resized) {
    return textResult(id, "image", fmt(T.messages.image_omitted, { mime }));
  }
  const dimNote = formatDimensionNote(resized);
  let note = fmt(T.messages.image_read, { mime: resized.mimeType });
  if (dimNote) note += `\n${dimNote}`;
  return {
    content: [
      { type: "text" as const, text: note },
      {
        type: "image" as const,
        data: resized.data,
        mimeType: resized.mimeType,
      },
    ],
    details: {
      id,
      kind: "image" as const,
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
      note,
    },
  };
}

export function videoResult(abs: string, id: string) {
  return textResult(
    id,
    "video",
    fmt(loadEditorText().messages.video_note, { path: abs }),
    { path: abs },
  );
}
