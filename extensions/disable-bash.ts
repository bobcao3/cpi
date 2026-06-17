import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function disableBuiltinBash(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const all = pi.getAllTools();
  const withoutBash = active.filter((name) => {
    const tool = all.find((t) => t.name === name && t.sourceInfo?.source === "builtin");
    return tool?.name !== "bash";
  });
  if (withoutBash.length !== active.length) {
    pi.setActiveTools(withoutBash);
  }
}

export default function (pi: ExtensionAPI) {
  // Disable the built-in bash tool whenever the session or resources reload.
  pi.on("session_start", async () => disableBuiltinBash(pi));
  pi.on("resources_discover", async () => disableBuiltinBash(pi));
}
