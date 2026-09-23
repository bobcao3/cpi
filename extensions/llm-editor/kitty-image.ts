import { randomInt } from "node:crypto";
import sharp from "sharp";
import {
  calculateImageRows,
  encodeKitty,
  getCellDimensions,
  getImageDimensions,
  imageFallback,
  truncateToWidth,
  type ImageDimensions,
} from "@earendil-works/pi-tui";

interface ImageState {
  source?: string;
  png?: string;
  pending?: boolean;
  failed?: boolean;
  imageId?: number;
  dimensions?: ImageDimensions | null;
  cachedWidth?: number;
  cachedLines?: string[];
}

export function renderKittyReadImage(
  image: { data: string; mimeType: string },
  text: string[],
  status: string,
  state: ImageState,
  invalidate: () => void,
) {
  if (state.source !== image.data) {
    state.source = image.data;
    state.png = image.mimeType === "image/png" ? image.data : undefined;
    state.pending = false;
    state.failed = false;
    state.imageId = randomInt(1, 0xffffffff);
    state.dimensions = undefined;
    state.cachedLines = undefined;
  }
  if (!state.png && !state.pending && !state.failed) {
    state.pending = true;
    const source = image.data;
    sharp(Buffer.from(source, "base64"), { limitInputPixels: 40_000_000 })
      .timeout({ seconds: 15 })
      .png()
      .toBuffer()
      .then((png) => {
        if (state.source === source) {
          state.png = png.toString("base64");
          state.dimensions = undefined;
          state.cachedLines = undefined;
          invalidate();
        }
      })
      .catch(() => {
        if (state.source === source) {
          state.failed = true;
          invalidate();
        }
      })
      .finally(() => {
        if (state.source === source) state.pending = false;
      });
  }
  return {
    invalidate() {},
    render(width: number): string[] {
      const lines = text.map((line) => truncateToWidth(line, width, "…"));
      if (state.png && state.imageId) {
        const dimensions =
          state.dimensions === undefined
            ? (state.dimensions = getImageDimensions(state.png, "image/png"))
            : state.dimensions;
        if (dimensions) {
          if (state.cachedWidth !== width || !state.cachedLines) {
            const columns = Math.max(1, Math.min(60, width - 2));
            const cell = getCellDimensions();
            const maxRows = Math.max(
              1,
              Math.ceil((columns * cell.widthPx) / cell.heightPx),
            );
            const rows = Math.min(
              maxRows,
              calculateImageRows(dimensions, columns),
            );
            state.cachedLines = [
              "",
              encodeKitty(state.png, {
                columns,
                rows,
                imageId: state.imageId,
                moveCursor: false,
              }),
              ...Array<string>(rows - 1).fill(""),
            ];
            state.cachedWidth = width;
          }
          lines.push(...state.cachedLines);
        } else {
          lines.push(imageFallback(image.mimeType));
        }
      } else if (state.failed) {
        lines.push(imageFallback(image.mimeType));
      }
      lines.push(truncateToWidth(status, width, "…"));
      return lines;
    },
  };
}
