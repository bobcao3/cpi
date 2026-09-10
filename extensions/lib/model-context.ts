import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { NOTIFICATION_TYPE, wrapNotification } from "./notification.ts";
import { loadText, render, textPath } from "./text.ts";

const ORIGIN_TYPE = "cpi-model-origin";

interface ModelIdentity {
  provider: string;
  modelId: string;
}

interface ModelContextText {
  change: { summary: string };
}

function saved_origin(ctx: ExtensionContext): ModelIdentity | undefined {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ORIGIN_TYPE) continue;
    const value = entry.data as Partial<ModelIdentity> | null;
    if (
      typeof value?.provider === "string" &&
      typeof value.modelId === "string"
    ) {
      return { provider: value.provider, modelId: value.modelId };
    }
  }
  return undefined;
}

export function registerModelContext(pi: ExtensionAPI) {
  let origin: ModelIdentity | undefined;
  const notification = (from: string, to: string) => {
    const text = loadText<ModelContextText>(
      "model-context",
      textPath("model-context"),
    );
    const details = {
      kind: "model-change" as const,
      summary: render(text.change.summary, { from, to }),
      payload: { from, to },
    };
    return {
      customType: NOTIFICATION_TYPE,
      content: wrapNotification(details),
      display: true,
      details,
    };
  };
  const remember = (model: { provider: string; id: string }): ModelIdentity => {
    if (!origin) {
      origin = { provider: model.provider, modelId: model.id };
      pi.appendEntry(ORIGIN_TYPE, origin);
    }
    return origin;
  };

  pi.on("session_start", (_event, ctx) => {
    origin = saved_origin(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    origin = saved_origin(ctx);
  });
  pi.on("context", (event, ctx) => {
    if (!ctx.model) return;
    origin ??= saved_origin(ctx);
    const initial = remember(ctx.model);
    let represented = `${initial.provider}/${initial.modelId}`;
    for (const message of event.messages) {
      if (message.role !== "custom") continue;
      const details = message.details as
        | {
            kind?: unknown;
            payload?: { to?: unknown };
            model?: ModelIdentity;
          }
        | undefined;
      if (message.customType === "cpi-context-checkpoint" && details?.model)
        represented = `${details.model.provider}/${details.model.modelId}`;
      if (
        message.customType === NOTIFICATION_TYPE &&
        details?.kind === "model-change" &&
        typeof details.payload?.to === "string"
      )
        represented = details.payload.to;
    }
    const current = `${ctx.model.provider}/${ctx.model.id}`;
    if (represented !== current) {
      const message = notification(represented, current);
      return {
        messages: [
          ...event.messages,
          {
            ...message,
            role: "custom" as const,
            timestamp: event.messages.at(-1)?.timestamp ?? 0,
          },
        ],
      };
    }
  });
  pi.on("model_select", (event, ctx) => {
    const { model, previousModel, source } = event;
    if (
      source === "restore" ||
      !previousModel ||
      (model.provider === previousModel.provider &&
        model.id === previousModel.id)
    )
      return;
    origin ??= saved_origin(ctx);
    remember(previousModel);
    const from = `${previousModel.provider}/${previousModel.id}`;
    const to = `${model.provider}/${model.id}`;
    pi.sendMessage(notification(from, to), { triggerTurn: false });
  });

  return (ctx: ExtensionContext): ModelIdentity => {
    if (!ctx.model)
      throw new Error("cpi system prompt requires an active model");
    origin ??= saved_origin(ctx);
    return remember(ctx.model);
  };
}

export default function modelContextExtension(pi: ExtensionAPI): void {
  registerModelContext(pi);
}
