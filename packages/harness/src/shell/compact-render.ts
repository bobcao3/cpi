import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { style_tool_tree } from "../lib/tool-style.ts";
import { cleanActivityDisplay } from "../lib/activity-details.ts";

export interface ShellTreeArgs {
  description?: string;
  command?: string;
  waitfor?: number;
  env?: string;
  is_pty?: boolean;
  id?: string;
  signal?: string;
}

export interface ShellTreeDetails {
  id?: string;
  describe?: string;
  shellName?: string;
  blocked?: string;
  shuckBlocked?: boolean;
  shuckWarnings?: string;
  status?: string;
  exitCode?: number | null;
  outputLines?: number;
  fullOutputPath?: string;
  logPath?: string;
  backendError?: string;
  uid?: string;
  socketPath?: string;
  isPty?: boolean;
  detached?: boolean;
  signal?: string;
  cdAgentsFiles?: string[];
  slowDown?: string;
}

export interface BackgroundTreeEntry {
  id: string;
  describe?: string;
  command?: string;
  logPath?: string;
  intervalSec?: number;
  uid?: string;
  socketPath?: string;
  isPty?: boolean;
}

type TreeContext = Pick<ToolTreeContext, "toolCallId">;

export function shellTreeText(snapshot: ToolTreeSnapshot<any, any>): string {
  return (snapshot.result?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export function shellTreeStatus(
  snapshot: ToolTreeSnapshot<any, any>,
): "error" | "success" | "running" | "queued" {
  if (
    snapshot.isError ||
    (snapshot.result as { isError?: boolean } | undefined)?.isError
  )
    return "error";
  if (snapshot.phase === "complete") return "success";
  if (snapshot.phase === "running") return "running";
  return "queued";
}

export function shellTreeVisible(value: string): string {
  return cleanActivityDisplay(value).trim();
}

export function shellTreeDetail(
  owner: string,
  section: string,
  label: string,
  text: string,
  status?: ToolTreeNode["status"],
): ToolTreeNode {
  return {
    id: `${owner}/${section}`,
    label,
    content: { text: cleanActivityDisplay(text, true).trim() },
    defaultOpen: false,
    ...(status ? { status } : {}),
  };
}

export function faintWarning(theme: Theme, text: string): string {
  return `\x1b[2m${theme.fg("warning", shellTreeVisible(text))}\x1b[22m`;
}

function elapsed(value: number): string {
  return value < 1500
    ? `${Math.round(value)}ms`
    : `${Math.round(value / 1000)}s`;
}

function makeNode(
  id: string,
  label: string,
  fields: Partial<ToolTreeNode> = {},
): ToolTreeNode {
  return { id, label, ...fields };
}

function warningNode(
  owner: string,
  section: string,
  text: string,
): ToolTreeNode {
  return makeNode(`${owner}/${section}`, section, {
    status: "warning",
    summary: shellTreeVisible(text).split("\n")[0] ?? "",
    content: { text: cleanActivityDisplay(text, true).trim() },
    defaultOpen: true,
  });
}

export function renderShellTree(
  snapshot: ToolTreeSnapshot<ShellTreeArgs, ShellTreeDetails>,
  theme: Theme,
  context: TreeContext,
  defaultWaitfor = 30,
  shellName = "shell",
): readonly ToolTreeNode[] {
  const args = snapshot.args;
  const details = snapshot.result?.details;
  const owner = context.toolCallId;
  const text = shellTreeText(snapshot);
  const blocked =
    details?.blocked ??
    (details?.shuckBlocked ? text.split("\n---\n")[0] : undefined);
  const failed =
    shellTreeStatus(snapshot) === "error" ||
    details?.backendError !== undefined ||
    (details?.exitCode != null && details.exitCode !== 0);
  const warnings = details?.shuckWarnings;
  const children: ToolTreeNode[] = [];
  if (args?.command)
    children.push(
      makeNode(`${owner}/command`, "Command", {
        content: { format: "code", language: "shell", text: args.command },
      }),
    );
  if (args?.env)
    children.push(
      shellTreeDetail(owner, "environment", "Environment", args.env),
    );
  if (blocked)
    children.push(
      shellTreeDetail(owner, "blocked", "Blocked", blocked, "error"),
    );
  if (warnings) children.push(warningNode(owner, "warnings", warnings));
  if (details?.slowDown)
    children.push(warningNode(owner, "poll-warning", details.slowDown));
  if (details?.backendError)
    children.push(
      shellTreeDetail(
        owner,
        "backend-error",
        "Backend failure",
        details.backendError,
        "error",
      ),
    );
  if (failed && !blocked && text)
    children.push(shellTreeDetail(owner, "failure", "Failure", text, "error"));
  if (details?.id && details.status === "running")
    children.push(
      makeNode(`${owner}/process`, `Background shell ${details.id}`, {
        summary: "running at launch",
        metadata: [
          details.uid ? `UID=${details.uid}` : "",
          details.isPty ? "PTY" : "not PTY",
        ].filter(Boolean),
      }),
    );
  if (details?.fullOutputPath)
    children.push(
      shellTreeDetail(
        owner,
        "full-output",
        "Full output",
        details.fullOutputPath,
      ),
    );
  if (details?.logPath)
    children.push(shellTreeDetail(owner, "log", "Log", details.logPath));
  if (details?.socketPath)
    children.push(
      shellTreeDetail(owner, "socket", "Socket", details.socketPath),
    );
  details?.cdAgentsFiles?.forEach((path) =>
    children.push(
      shellTreeDetail(
        owner,
        `instructions/${encodeURIComponent(path)}`,
        path,
        path,
      ),
    ),
  );
  const complete = snapshot.phase === "complete";
  const summary = shellTreeVisible(
    details?.describe || args?.description || "shell",
  );
  const metadata: string[] = [];
  if (blocked) metadata.push("Blocked");
  else if (details?.backendError) metadata.push("Backend failure");
  if (snapshot.durationMs !== undefined)
    metadata.push(elapsed(snapshot.durationMs));
  if (!complete) metadata.push(`wait for ${args?.waitfor ?? defaultWaitfor}s`);
  if (complete && details?.status === "running")
    metadata.push(
      theme.fg("warning", "backgrounded") +
        " " +
        faintWarning(theme, `PID=${details.id ?? "unknown"}`),
    );
  else if (complete && details?.exitCode != null && details.exitCode !== 0) {
    metadata.push(`exit ${details.exitCode}`);
    if (details.exitCode !== 0 && details.outputLines != null)
      metadata.push(`${details.outputLines} output lines`);
  }
  return [
    makeNode(
      owner,
      theme.fg(
        failed || blocked
          ? "error"
          : details?.status === "running" || !complete
            ? "warning"
            : "success",
        details?.shellName ?? shellName,
      ),
      {
        summary: theme.fg("dim", summary),
        status:
          blocked ||
          details?.backendError ||
          (details?.exitCode != null && details.exitCode !== 0)
            ? "error"
            : shellTreeStatus(snapshot),
        metadata: metadata.map((value) =>
          value.includes("\x1b")
            ? value
            : theme.fg(
                failed && value.startsWith("exit ") ? "error" : "muted",
                value,
              ),
        ),
        children: style_tool_tree(children, theme),
        defaultOpen:
          !failed && !blocked && Boolean(warnings || details?.slowDown),
      },
    ),
  ];
}
