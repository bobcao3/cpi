import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

export interface VisualLinePreviewOptions {
  text: string;
  maxVisualLines: number;
  keep: "start" | "end";
  formatHint: (hidden: number) => string;
}

export class VisualLinePreview implements Component {
  private readonly options: VisualLinePreviewOptions;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: VisualLinePreviewOptions) {
    this.options = options;
  }

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const { text, maxVisualLines, keep, formatHint } = this.options;
      const preview = truncateToVisualLines(
        text,
        maxVisualLines,
        width,
        0,
        keep,
      );
      const lines = preview.visualLines;
      if (preview.skippedCount > 0) {
        const hint = truncateToWidth(
          formatHint(preview.skippedCount),
          width,
          "...",
        );
        this.cachedLines =
          keep === "start" ? [...lines, hint] : [hint, ...lines];
      } else this.cachedLines = lines;
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
