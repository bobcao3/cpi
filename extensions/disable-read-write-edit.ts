import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = new Set(["read", "write", "edit"]);

function disableReadWriteEdit(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const all = pi.getAllTools();
  const without = active.filter((name) => {
    const tool = all.find((t) => t.name === name && t.sourceInfo?.source === "builtin");
    return !(tool && DISABLED.has(tool.name));
  });
  if (without.length !== active.length) {
    pi.setActiveTools(without);
  }
}

export default function (pi: ExtensionAPI) {
  // Remove read/write/edit from the active tool set on startup and reload.
  pi.on("session_start", async () => disableReadWriteEdit(pi));
  pi.on("resources_discover", async () => disableReadWriteEdit(pi));

  // Block any attempt to call them, e.g. from a resumed session.
  pi.on("tool_call", async (event) => {
    if (DISABLED.has(event.toolName)) {
      return { block: true, reason: `${event.toolName} is disabled in cpi; use the \`sh\` tool instead` };
    }
  });
}
