import { isImageLine } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TreeNode, TreeState, TreeViewTheme } from "./tree-view.ts";
import {
  type FlatNode,
  type HitRow,
  MAX_ROWS,
  RUNNING_FRAMES,
  STATUS_TEXT,
} from "./tree-view-helpers.ts";

export function renderTreeLayout(
  flat: readonly FlatNode[],
  width: number,
  state: TreeState,
  theme: Required<TreeViewTheme>,
  isOpen: (node: TreeNode) => boolean,
  shownCount: (id: string, total: number) => number,
): { lines: string[]; hits: HitRow[]; positions: Map<string, number> } {
  const lines: string[] = [];
  const hits: HitRow[] = [];
  const positions = new Map<string, number>();
  const fit = (text: string) => truncateToWidth(text, width, "");
  const pending: FlatNode[] = [];
  const surfaces: {
    depth: number;
    surface: NonNullable<TreeNode["surface"]>;
  }[] = [];
  const paint = (text: string) => {
    const surface = surfaces.at(-1)?.surface;
    return surface && !isImageLine(text)
      ? surface.background(
          text + " ".repeat(Math.max(0, width - visibleWidth(text))),
        )
      : text;
  };
  const closeSurface = () => {
    const edge = surfaces.pop()!.surface.edge;
    if (edge && lines.length < MAX_ROWS - 1)
      lines.push(fit(edge("bottom", width)));
  };
  const more = (item: FlatNode) => {
    const children = item.node.children ?? [];
    const shown = shownCount(item.node.id, children.length);
    if (
      !isOpen(item.node) ||
      shown >= children.length ||
      lines.length >= MAX_ROWS - 1
    )
      return;
    const guide = item.ancestorLast
      .map((last) => (last ? "  " : "│ "))
      .join("");
    const prefix = truncateToWidth(
      `  ${theme.guide(`${guide}  └─`)}▸ `,
      Math.max(0, width - 1),
      "",
    );
    hits.push({
      kind: "more",
      id: item.node.id,
      y: lines.length,
      markerStart: 0,
      markerEnd: width,
    });
    lines.push(paint(fit(`${prefix}${children.length - shown} more`)));
  };
  for (const item of flat) {
    while (pending.length && pending[pending.length - 1]!.depth >= item.depth)
      more(pending.pop()!);
    while (surfaces.length && surfaces.at(-1)!.depth >= item.depth)
      closeSurface();
    if (lines.length >= MAX_ROWS - 1) break;
    const node = item.node;
    if (node.surface) {
      surfaces.push({ depth: item.depth, surface: node.surface });
      if (node.surface.edge) lines.push(fit(node.surface.edge("top", width)));
    }
    const rawStatus =
      node.status === "running"
        ? RUNNING_FRAMES[Math.abs(state.frame ?? 0) % RUNNING_FRAMES.length]!
        : node.status
          ? STATUS_TEXT[node.status]
          : " ";
    const status = node.status
      ? `${theme.status(truncateToWidth(rawStatus, 1, ""), node.status)} `
      : "  ";
    const maxGuides = Math.max(
      0,
      Math.floor((width - (item.depth ? 7 : 5)) / 2),
    );
    const ancestors = item.ancestorLast.slice(
      -maxGuides || item.ancestorLast.length,
    );
    const guide = theme.guide(
      ancestors.map((last) => (last ? "  " : "│ ")).join(""),
    );
    const last = item.childIndex === item.childCount - 1;
    const branch = theme.guide(
      item.depth && width >= 7 ? (last ? "└─" : "├─") : "",
    );
    const expandable = Boolean(node.body || node.children?.length);
    const marker = expandable ? (isOpen(node) ? "▾ " : "▸ ") : "  ";
    const statusPrefix = width >= 4 ? status : "";
    const prefix = truncateToWidth(
      statusPrefix + guide + branch + marker,
      Math.max(0, width - 1),
      "",
    );
    const markerStart = visibleWidth(statusPrefix + guide + branch);
    const markerEnd = Math.min(width, markerStart + 2);
    const text = [node.label, node.summary]
      .filter(Boolean)
      .join(" · ")
      .replace(/[\r\n\t]+/g, " ");
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const header = wrapTextWithAnsi(text, contentWidth).slice(0, 3);
    if (wrapTextWithAnsi(text, contentWidth).length > 3)
      header[2] = truncateToWidth(header[2]!, contentWidth, "…");
    const metadata = (node.metadata ?? [])
      .join(" · ")
      .replace(/[\r\n\t]+/g, " ");
    if (metadata) {
      const lastLine = header[header.length - 1] ?? "";
      if (
        header.length === 1 &&
        visibleWidth(`${lastLine} · ${metadata}`) <= contentWidth
      )
        header[0] = `${lastLine} · ${metadata}`;
      else header.push(...wrapTextWithAnsi(metadata, contentWidth).slice(0, 2));
    }
    const continuation = truncateToWidth(
      " ".repeat(visibleWidth(statusPrefix)) +
        guide +
        theme.guide(item.depth && width >= 7 ? (last ? "  " : "│ ") : "") +
        "  ",
      visibleWidth(prefix),
      "",
    );
    positions.set(node.id, lines.length);
    for (let i = 0; i < header.length && lines.length < MAX_ROWS - 1; i++) {
      const line = fit((i ? continuation : prefix) + header[i]!);
      hits.push({
        kind: "header",
        id: node.id,
        y: lines.length,
        markerStart: i ? -1 : markerStart,
        markerEnd: i ? -1 : markerEnd,
      });
      lines.push(
        node.id === state.selectedId
          ? theme.selected(paint(line))
          : paint(line),
      );
    }
    if (!isOpen(node)) continue;
    if (node.body) {
      const bodyGuide =
        item.depth === 0 ? "  " : guide + theme.guide(last ? "  " : "│ ");
      const bodyPrefix = truncateToWidth(
        `  ${bodyGuide}  `,
        Math.max(0, width - 1),
        "",
      );
      const bodyWidth = Math.max(0, width - visibleWidth(bodyPrefix));
      const bodyLines = node.body.render(bodyWidth);
      for (
        let i = 0;
        i < bodyLines.length && lines.length < MAX_ROWS - 1;
        i++
      ) {
        hits.push({
          kind: "body",
          id: node.id,
          y: lines.length,
          markerStart: 0,
          markerEnd: visibleWidth(bodyPrefix),
          body: node.body,
          bodyY: i,
          bodyWidth,
          bodyHeight: bodyLines.length,
        });
        lines.push(
          isImageLine(bodyLines[i]!)
            ? `\x1b[${visibleWidth(bodyPrefix)}C${bodyLines[i]!}`
            : paint(fit(bodyPrefix + bodyLines[i]!)),
        );
      }
    }
    if (
      shownCount(node.id, node.children?.length ?? 0) <
      (node.children?.length ?? 0)
    )
      pending.push(item);
  }
  while (pending.length) more(pending.pop()!);
  while (surfaces.length) closeSurface();
  if (lines.length >= MAX_ROWS - 1)
    lines.push(fit("… display row limit; retained content remains available"));
  return { lines, hits, positions };
}
