import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";

export function treeStyles(theme?: Theme): string {
  const colors = theme?.colors;
  const variables = colors
    ? `--cpi-tree-pending:${colorToHex(colors.toolPendingBg)};--cpi-tree-success:${colorToHex(colors.toolSuccessBg)};--cpi-tree-error:${colorToHex(colors.toolErrorBg)};--cpi-tree-border:${colorToHex(colors.border)};--cpi-tree-muted:${colorToHex(colors.muted)};--cpi-tree-text:${colorToHex(colors.toolOutput)};--cpi-tree-status-error:${colorToHex(colors.error)};--cpi-tree-status-success:${colorToHex(colors.success)};--cpi-tree-status-warning:${colorToHex(colors.warning)};`
    : "";
  return `<style>
.cpi-tool-tree{${variables}color:var(--cpi-tree-text,inherit);font-family:ui-monospace,monospace;overflow-wrap:anywhere}
.cpi-tool-tree .tool-tree-node{margin:.35em 0;padding:.35em .65em;border-radius:.3em}
.cpi-tool-tree .tool-tree-node .tool-tree-node{margin-left:1em}
.cpi-tool-tree summary{cursor:pointer;white-space:pre-wrap}
.cpi-tool-tree .tool-tree-label{font-weight:600}
.cpi-tool-tree .tool-tree-summary,.cpi-tool-tree .tool-tree-metadata{color:var(--cpi-tree-muted,inherit)}
.cpi-tool-tree .tool-tree-content{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;margin:.5em 0;font:inherit}
.cpi-tool-tree .tool-tree-image{display:block;max-width:100%;height:auto;margin:.5em 0}
.cpi-tool-tree [data-background="toolPendingBg"]{--cpi-tree-surface:var(--cpi-tree-pending);background:var(--cpi-tree-pending,transparent)}
.cpi-tool-tree [data-background="toolSuccessBg"]{--cpi-tree-surface:var(--cpi-tree-success);background:var(--cpi-tree-success,transparent)}
.cpi-tool-tree [data-background="toolErrorBg"]{--cpi-tree-surface:var(--cpi-tree-error);background:var(--cpi-tree-error,transparent)}
.cpi-tool-tree [data-frame="true"]{border:1px solid var(--cpi-tree-border,currentColor)}
.cpi-tool-tree [data-status="error"]{color:var(--cpi-tree-status-error,#e55)}
.cpi-tool-tree [data-status="success"]{color:var(--cpi-tree-status-success,#5a5)}
.cpi-tool-tree [data-status="running"],.cpi-tool-tree [data-status="queued"]{color:var(--cpi-tree-status-warning,#da5)}
</style>`;
}
