import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { getReadmePath } from "@earendil-works/pi-coding-agent";
import {
  getLanguageFromPath,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { formatPathRelativeToCwdOrAbsolute } from "../paths.ts";
import type { ToolRenderers } from "../renderer-types.ts";
import type { ToolTreeNode } from "../tool-tree.ts";
import { resolveToCwd } from "../paths.ts";
import { renderToolPath, replaceTabs, str } from "./render-utils.ts";
import {
  resultImages,
  resultNotices,
  textOutput,
  toolStatus,
} from "./tree-content.ts";

interface CompactReadClassification {
  kind: "docs" | "resource" | "skill";
  label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);
type ReadRenderArgs = {
  path?: string;
  file_path?: string;
  offset?: number;
  limit?: number;
};
function formatReadLineRange(
  args: ReadRenderArgs | undefined,
  theme: Theme,
): string {
  // Strict tool schemas make models send null for omitted optional fields.
  if (args?.offset == null && args?.limit == null) return "";
  const startLine = args.offset ?? 1;
  const endLine = args.limit != null ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}
function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}
function getPiDocsClassification(
  absolutePath: string,
): CompactReadClassification | undefined {
  const packageRoot = dirname(getReadmePath());
  const relativePath = relative(
    resolvePath(packageRoot),
    resolvePath(absolutePath),
  );
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const label = toPosixPath(relativePath);
  if (
    label === "README.md" ||
    label.startsWith("docs/") ||
    label.startsWith("examples/")
  ) {
    return { kind: "docs", label };
  }
  return undefined;
}
function getCompactReadClassification(
  args: ReadRenderArgs | undefined,
  cwd: string,
): CompactReadClassification | undefined {
  const rawPath = str(args?.file_path ?? args?.path);
  if (!rawPath) return undefined;

  const absolutePath = resolveToCwd(rawPath, cwd);
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return {
      kind: "skill",
      label: basename(dirname(absolutePath)) || fileName,
    };
  }

  const docsClassification = getPiDocsClassification(absolutePath);
  if (docsClassification) return docsClassification;

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return {
      kind: "resource",
      label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd),
    };
  }

  return undefined;
}
export const readRenderers: ToolRenderers = {
  renderTree(snapshot, theme, context) {
    const args = snapshot.args as ReadRenderArgs;
    const classification = getCompactReadClassification(args, context.cwd);
    const path = str(args.file_path ?? args.path);
    const id = context.toolCallId;
    const output = textOutput(snapshot);
    const language =
      !snapshot.isError && path ? getLanguageFromPath(path) : undefined;
    const children: ToolTreeNode[] = output
      ? [
          {
            id: `${id}/content`,
            label: snapshot.isError ? "Error" : "Content",
            summary: `${output.split("\n").length} lines`,
            content: {
              text: replaceTabs(output),
              format: language ? "code" : "text",
              language,
            },
            defaultOpen: snapshot.isError,
          },
        ]
      : [];
    children.push(
      ...resultNotices(id, snapshot.result?.details),
      ...resultImages(id, snapshot),
    );
    return [
      {
        id,
        label:
          classification?.kind === "skill"
            ? "[skill]"
            : classification
              ? `read ${classification.kind}`
              : "read",
        summary:
          (classification
            ? theme.fg("accent", classification.label)
            : renderToolPath(path, theme, context.cwd)) +
          formatReadLineRange(args, theme),
        status: toolStatus(snapshot),
        children,
        defaultOpen: true,
      },
    ];
  },
};
