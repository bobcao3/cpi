import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "./tree/index.ts";
import { style_tool_tree } from "./lib/tool-style.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { cleanActivityDisplay } from "./lib/activity-details.ts";
import type { Diagnostic } from "./lib/lsp/diagnostics.ts";

interface LspArgs {
  command?: string;
  file?: string;
  project_dir?: string;
}
export interface LspRenderDetails {
  diagnosticCount?: number;
  errorCount?: number;
  diagnostics?: Diagnostic[];
  fullPath?: string;
  language?: string;
  state?: string;
  sessionId?: string;
  root?: string;
  bin?: string;
  source?: string;
  env?: string;
  sessions?: {
    id: string;
    language: string;
    root: string;
    bin: string;
    env?: string;
    state: string;
  }[];
}
const visible = (value: string) => cleanActivityDisplay(value).trim();
function detail(
  owner: string,
  section: string,
  label: string,
  text: string,
): ToolTreeNode {
  return {
    id: `${owner}/${section}`,
    label,
    content: { text },
    defaultOpen: false,
  };
}
function diagnostics(
  owner: string,
  details: LspRenderDetails | undefined,
  raw: string,
): ToolTreeNode[] {
  const seen = new Map<string, number>();
  const nodes: ToolTreeNode[] = (details?.diagnostics ?? []).map(
    (diagnostic) => {
      const key = JSON.stringify([
        diagnostic.file,
        diagnostic.startLine,
        diagnostic.startCol,
        diagnostic.endLine,
        diagnostic.endCol,
        diagnostic.source,
        diagnostic.code,
        diagnostic.severity,
        diagnostic.message,
      ]);
      const duplicate = seen.get(key) ?? 0;
      seen.set(key, duplicate + 1);
      return {
        id: `${owner}/diagnostic/${encodeURIComponent(key)}/${duplicate}`,
        label: `L${diagnostic.startLine}:${diagnostic.startCol} ${diagnostic.severity}[${visible(diagnostic.source)}]`,
        summary: visible(diagnostic.message),
        metadata: [visible(diagnostic.file), diagnostic.code ?? ""].filter(
          Boolean,
        ),
        status:
          diagnostic.severity === "error"
            ? "error"
            : diagnostic.severity === "warning"
              ? "warning"
              : undefined,
        content: {
          text: `${diagnostic.message}\n${diagnostic.file}:${diagnostic.startLine}:${diagnostic.startCol}-${diagnostic.endLine}:${diagnostic.endCol}`,
        },
      };
    },
  );
  if (!nodes.length && !raw.startsWith("no diagnostics for ")) {
    raw
      .split("\n")
      .filter(Boolean)
      .forEach((line, index) =>
        nodes.push({
          id: `${owner}/diagnostic/${index}`,
          label: visible(line),
          status: /^L\d+:\d+ error\[/.test(line)
            ? "error"
            : /^L\d+:\d+ warning\[/.test(line)
              ? "warning"
              : undefined,
        }),
      );
  }
  const shown = nodes.slice(0, 3);
  if (nodes.length > 3)
    shown.push({
      id: `${owner}/remaining`,
      label: "More diagnostics",
      summary: `${nodes.length - 3}`,
      children: nodes.slice(3),
    });
  if ((details?.diagnosticCount ?? 0) > nodes.length)
    shown.push({
      id: `${owner}/overflow`,
      label: "Additional diagnostics",
      summary: `${details!.diagnosticCount! - nodes.length}`,
      content: {
        text: raw
          .split("\n")
          .filter((line) => line.startsWith("…"))
          .join("\n"),
      },
    });
  if (details?.fullPath)
    shown.push(
      detail(owner, "full-output", "Full diagnostics", details.fullPath),
    );
  return shown;
}

export function renderLspTree(
  snapshot: ToolTreeSnapshot<LspArgs, LspRenderDetails>,
  theme: Theme,
  context: Pick<ToolTreeContext, "toolCallId">,
): readonly ToolTreeNode[] {
  const { args, result, phase } = snapshot;
  const owner = context.toolCallId;
  const raw =
    result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const details = result?.details;
  const command = args.command ?? "check";
  const failed =
    snapshot.isError || (result as { isError?: boolean } | undefined)?.isError;
  const root: ToolTreeNode = {
    id: owner,
    label: `lsp ${command.replaceAll("_", " ")}`,
    summary: visible(args.file ?? args.project_dir ?? ""),
    status: failed
      ? "error"
      : phase === "complete"
        ? "success"
        : phase === "running"
          ? "running"
          : "queued",
    defaultOpen: Boolean(failed),
    children: [],
  };
  if (failed) {
    root.children = [
      {
        ...detail(owner, "failure", "Failure", raw),
        status: "error",
        defaultOpen: true,
      },
    ];
  } else if (phase === "complete" && command === "check") {
    const count = details?.diagnosticCount;
    const has =
      count === undefined ? !raw.startsWith("no diagnostics for ") : count > 0;
    root.metadata = [
      count === undefined
        ? has
          ? "diagnostics reported"
          : "no diagnostics"
        : `${count} diagnostics`,
      details?.errorCount ? `${details.errorCount} errors` : "",
    ].filter(Boolean);
    root.children = has ? diagnostics(owner, details, raw) : [];
    root.defaultOpen = has;
  } else if (phase === "complete" && command === "start") {
    const state =
      details?.state ?? /\bstate=(\S+)/.exec(raw)?.[1] ?? "starting";
    root.metadata = [visible(details?.language ?? ""), visible(state)].filter(
      Boolean,
    );
    root.children = [
      {
        id: `${owner}/session/${encodeURIComponent(details?.sessionId ?? /session (\S+)/.exec(raw)?.[1] ?? "session")}`,
        label: "Session",
        summary: visible(state),
        status:
          state === "ready"
            ? "success"
            : state === "dead" || state === "install-failed"
              ? "error"
              : "warning",
        content: { text: raw },
      },
    ];
  } else if (phase === "complete" && command === "stop") {
    root.summary = visible(raw);
    root.children = [detail(owner, "outcome", "Outcome", raw)];
  } else if (phase === "complete" && command === "list_sessions") {
    const sessions =
      details?.sessions ??
      (raw === "No LSP sessions."
        ? []
        : raw
            .split("\n")
            .slice(1)
            .filter(Boolean)
            .map((line) => {
              const [id, language, root, bin, env, state] = line.split("\t");
              return {
                id: id ?? "",
                language: language ?? "",
                root: root ?? "",
                bin: bin ?? "",
                env,
                state: state ?? "",
              };
            }));
    root.summary = sessions.length ? `${sessions.length} sessions` : "none";
    root.children = sessions.map((session) => ({
      id: `${owner}/session/${encodeURIComponent(session.id)}`,
      label: visible(session.language),
      summary: visible(session.root),
      metadata: [
        visible(session.id),
        visible(session.state),
        visible(session.bin),
      ],
      status:
        session.state === "ready"
          ? "success"
          : session.state === "dead" || session.state === "install-failed"
            ? "error"
            : "warning",
      children: session.env
        ? [
            detail(
              `${owner}/session/${encodeURIComponent(session.id)}`,
              "environment",
              "Environment",
              session.env,
            ),
          ]
        : [],
    }));
  } else if (phase === "complete" && command === "list_supported_servers") {
    const lines = raw.split("\n").filter(Boolean);
    root.summary = `${lines.length} supported servers`;
    root.children = lines.map((line) => ({
      id: `${owner}/server/${encodeURIComponent(line.split(" ")[0]!)}`,
      label: visible(line.split(" ")[0]!),
      summary: visible(line.slice(line.indexOf(" ") + 1)),
      content: { text: line },
    }));
  }
  return style_tool_tree([root], theme);
}
