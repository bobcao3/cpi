import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

export type VisualLinePreviewOptions = {
  maxVisualLines: number;
  keep: "start" | "end";
  formatHint: (hidden: number) => string;
} & (
  | { text: string; component?: never }
  | { component: Component; text?: never }
);

export class VisualLinePreview implements Component {
  private readonly options: VisualLinePreviewOptions;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: VisualLinePreviewOptions) {
    this.options = options;
  }

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const { text, component, maxVisualLines, keep, formatHint } =
        this.options;
      const rendered = component
        ? component.render(width)
        : text
          ? text.split("\n").map((line) => truncateToWidth(line, width, ""))
          : [];
      const preview = {
        visualLines:
          keep === "start"
            ? rendered.slice(0, maxVisualLines)
            : rendered.slice(Math.max(0, rendered.length - maxVisualLines)),
        skippedCount: Math.max(0, rendered.length - maxVisualLines),
      };
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
    this.options.component?.invalidate();
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
