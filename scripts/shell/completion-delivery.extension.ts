import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { drainBeforeUser } from "../../extensions/lib/prepend-message.ts";
import { surfaceCompletedShells } from "../../extensions/shell/orphan.ts";

export default function (pi: ExtensionAPI) {
  const surface = (ctx: ExtensionContext) =>
    surfaceCompletedShells(
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile(),
    );
  pi.on("session_start", async (_event, ctx) => {
    await surface(ctx);
  });
  pi.registerCommand("queue-completions", {
    description: "",
    handler: async (_args, ctx) => {
      await surface(ctx);
    },
  });
  pi.registerCommand("deliver-completions", {
    description: "",
    handler: async (_args, ctx) => drainBeforeUser(pi, ctx),
  });
}
