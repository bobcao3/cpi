import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCompletionHook, silenceChild } from "../../src/shell/exec.ts";

const shared = globalThis as typeof globalThis & {
  __cpiTestStaleCallback?: { api: ExtensionAPI; error?: string };
};

export default function (pi: ExtensionAPI) {
  const state = (shared.__cpiTestStaleCallback ??= { api: pi });
  pi.registerCommand("silence-completion", {
    description: "",
    handler: async (id) => {
      if (!silenceChild(id)) throw new Error("Shell is not active");
    },
  });
  pi.registerCommand("arm-stale-callback", {
    description: "",
    handler: async () => {
      setCompletionHook(() => {
        try {
          state.api.sendMessage(
            { customType: "notification", content: "Completed", display: true },
            { triggerTurn: false },
          );
        } catch (error) {
          state.error = (error as Error).message;
          throw error;
        }
      });
    },
  });
  pi.registerCommand("report-stale-callback", {
    description: "",
    handler: async () => {
      pi.appendEntry("cpi-callback-failure", state.error);
    },
  });
}
