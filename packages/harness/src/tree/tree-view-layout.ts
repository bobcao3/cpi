import { isCompactWidth, isImageLine } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TreeNode, TreeState, TreeViewTheme } from "./tree-view.ts";
import { hasExpandableContent } from "./tree-view-contract.ts";
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
  screenHeight: number,
): { lines: string[]; hits: HitRow[]; positions: Map<string, number> } {
  const lines: string[] = [];
  const hits: HitRow[] = [];
  const positions = new Map<string, number>();
  let limited = false;
  const compact = isCompactWidth(width);
  const space = compact ? " " : "  ";
  const vertical = compact ? "│" : "│ ";
  const branchLast = compact ? "└" : "└─";
  const branchNext = compact ? "├" : "├─";
  const fit = (text: string) => truncateToWidth(text, width, "");
  const pending: FlatNode[] = [];
  const disclosures: {
    item: FlatNode;
    start: number;
    prefix: string;
    bodyFooter: boolean;
  }[] = [];
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
      .map((last) => (last ? space : vertical))
      .join("");
    const prefix = truncateToWidth(
      `${space}${theme.guide(`${guide}${space}${branchLast}`)}${"▸".padEnd(space.length)}`,
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
  const control = (
    kind: "collapse" | "body-toggle",
    id: string,
    prefix: string,
    hint: string,
    large: boolean,
  ) => {
    if (lines.length >= MAX_ROWS - 1) {
      limited = true;
      lines.pop();
      while (hits.at(-1) && hits.at(-1)!.y >= lines.length) hits.pop();
    }
    hits.push({
      kind,
      id,
      y: lines.length,
      markerStart: visibleWidth(prefix),
      markerEnd: width,
      large,
    });
    lines.push(paint(fit(prefix + hint)));
  };
  const closeDisclosure = () => {
    const frame = disclosures.pop()!;
    if (
      lines.length - frame.start <= screenHeight / 2 ||
      (frame.bodyFooter && !frame.item.node.children?.length)
    )
      return;
    control(
      "collapse",
      frame.item.node.id,
      frame.prefix,
      frame.item.node.collapseHint ?? "[-] Click or Ctrl-Minus to collapse",
      true,
    );
  };
  const closeThrough = (depth: number) => {
    let closing: number;
    while (
      (closing = Math.max(
        pending.at(-1)?.depth ?? -1,
        disclosures.at(-1)?.item.depth ?? -1,
        surfaces.at(-1)?.depth ?? -1,
      )) >= depth
    ) {
      if (pending.at(-1)?.depth === closing) more(pending.pop()!);
      if (disclosures.at(-1)?.item.depth === closing) closeDisclosure();
      if (surfaces.at(-1)?.depth === closing) closeSurface();
    }
  };
  for (const item of flat) {
    closeThrough(item.depth);
    if (lines.length >= MAX_ROWS - 1) break;
    const node = item.node;
    const visualDepth = item.ancestorLast.length;
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
      ? theme.status(truncateToWidth(rawStatus, 1, ""), node.status) +
        (compact ? "" : " ")
      : space;
    const minimumHeaderWidth =
      2 * space.length + 1 + (visualDepth ? space.length : 0);
    const maxGuides = Math.max(
      0,
      Math.floor((width - minimumHeaderWidth) / space.length),
    );
    const ancestors = item.ancestorLast.slice(
      -maxGuides || item.ancestorLast.length,
    );
    const guide = theme.guide(
      ancestors.map((last) => (last ? space : vertical)).join(""),
    );
    const last = item.childIndex === item.childCount - 1;
    const branch = theme.guide(
      visualDepth && width >= minimumHeaderWidth
        ? item.flattened
          ? last
            ? space
            : vertical
          : last
            ? branchLast
            : branchNext
        : "",
    );
    const expandable = hasExpandableContent(node, item.flattened);
    const section = item.flattened && !node.status;
    const caption = section && !node.labelJoined && !node.metadata?.length;
    const marker = (
      section
        ? " "
        : expandable
          ? isOpen(node)
            ? "▾"
            : "▸"
          : item.depth === 0 || node.status
            ? "-"
            : " "
    ).padEnd(space.length);
    const statusPrefix = width >= space.length + space.length ? status : "";
    const prefix = truncateToWidth(
      statusPrefix + guide + branch + marker,
      Math.max(0, width - 1),
      "",
    );
    const markerStart = visibleWidth(
      section ? prefix : statusPrefix + guide + branch,
    );
    const markerEnd = section
      ? width
      : Math.min(width, markerStart + marker.length);
    const text = [caption ? `${node.label}:` : node.label, node.summary]
      .filter(Boolean)
      .join(caption ? " " : " · ")
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
        theme.guide(
          visualDepth && width >= minimumHeaderWidth
            ? last
              ? space
              : vertical
            : "",
        ) +
        space,
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
    if (!item.flattened && !isOpen(node)) continue;
    const disclosure =
      !item.flattened && expandable
        ? {
            item,
            start: positions.get(node.id)!,
            prefix: continuation,
            bodyFooter: false,
          }
        : undefined;
    if (disclosure) disclosures.push(disclosure);
    if (node.body) {
      const bodyGuide =
        visualDepth === 0
          ? compact
            ? ""
            : space
          : guide + theme.guide(last ? space : vertical);
      const bodyPrefix = truncateToWidth(
        item.flattened || node.bodyInline
          ? continuation
          : `${space}${bodyGuide}${space}`,
        Math.max(0, width - 1),
        "",
      );
      const bodyWidth = Math.max(0, width - visibleWidth(bodyPrefix));
      const expanded =
        state.fullBodies?.get(node.id) ?? Boolean(state.expanded);
      const previewLines = node.bodyPreview?.render(bodyWidth);
      const fullLines = node.body.render(bodyWidth);
      const body = node.bodyPreview && !expanded ? node.bodyPreview : node.body;
      const bodyLines = body === node.body ? fullLines : previewLines!;
      const truncated =
        previewLines !== undefined && fullLines.length > previewLines.length;
      const bodyStart = lines.length;
      const bodyLimit = MAX_ROWS - 1 - disclosures.length - Number(truncated);
      for (let i = 0; i < bodyLines.length && lines.length < bodyLimit; i++) {
        hits.push({
          kind: "body",
          id: node.id,
          y: lines.length,
          markerStart: 0,
          markerEnd: visibleWidth(bodyPrefix),
          body,
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
      limited ||= lines.length - bodyStart < bodyLines.length;
      if (truncated) {
        const large =
          expanded && bodyLines.length + header.length + 1 > screenHeight / 2;
        const keyboardToggle = expanded === Boolean(state.expanded);
        const hint =
          node.bodyExpansionHint?.(expanded, keyboardToggle, large) ??
          `${expanded ? "[-]" : "..."} Click${large ? " or Ctrl-Minus" : keyboardToggle ? " or Ctrl-O" : ""} to ${expanded ? "collapse" : "expand"}`;
        control("body-toggle", node.id, bodyPrefix, hint, large);
        if (disclosure) disclosure.bodyFooter = expanded;
      }
    }
    if (
      shownCount(node.id, node.children?.length ?? 0) <
      (node.children?.length ?? 0)
    )
      pending.push(item);
  }
  closeThrough(0);
  if (limited || lines.length >= MAX_ROWS - 1)
    lines.push(fit("… display row limit; retained content remains available"));
  return { lines, hits, positions };
}
