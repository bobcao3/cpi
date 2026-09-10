import { contentText, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
  sessionEntryToContextMessages,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { discoverAgentsPaths } from "./agents.ts";
import { getCwd } from "./cwd.ts";
import { registerCompactionDisplay } from "./compaction-display.ts";
import {
  collectReferences,
  stripReferenceBodies,
  type ReferenceBundle,
} from "./compaction-references.ts";
import { collectRuntimeState } from "./compaction-state.ts";
import {
  buildCheckpoint,
  projectCheckpoint,
  type ContextCheckpoint,
} from "./compaction-checkpoint.ts";
import { loadText, render, textPath } from "./text.ts";

type CompactionText = {
  summary: { system: string; prompt: string; file_lists: string };
  errors: { failed: string; budget: string; empty: string; changed: string };
};

function summaryBudget(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  checkpoint: ContextCheckpoint,
  text: CompactionText,
  tools_tokens: number,
): number {
  const { preparation, branchEntries } = event;
  const model = ctx.model;
  if (!model) throw new Error("Compaction requires an active model");
  const kept_start = branchEntries.findIndex(
    (entry) => entry.id === preparation.firstKeptEntryId,
  );
  if (kept_start < 0)
    throw new Error(
      "Compaction kept boundary is absent from the active branch",
    );
  const kept = stripReferenceBodies(
    branchEntries.slice(kept_start).flatMap(sessionEntryToContextMessages),
    checkpoint.documents,
  );
  const restoration = estimateTokens({
    role: "user",
    content: checkpoint.content,
    timestamp: 0,
  });
  const system = estimateTokens({
    role: "user",
    content: ctx.getSystemPrompt(),
    timestamp: 0,
  });
  const available =
    model.contextWindow -
    preparation.settings.reserveTokens -
    restoration -
    kept.reduce((total, message) => total + estimateTokens(message), 0) -
    system -
    tools_tokens -
    1024;
  const budget = Math.floor(
    Math.min(
      0.8 * preparation.settings.reserveTokens,
      model.maxTokens || Infinity,
      available,
    ),
  );
  if (budget < 128) throw new Error(text.errors.budget);
  return budget;
}

function toolTokens(pi: ExtensionAPI): number {
  const active = new Set(pi.getActiveTools());
  const schemas = pi
    .getAllTools()
    .filter((tool) => active.has(tool.name))
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  return estimateTokens({
    role: "user",
    content: JSON.stringify(schemas),
    timestamp: 0,
  });
}

async function summarizeTask(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  references: ReferenceBundle,
  maxTokens: number,
  text: CompactionText,
) {
  const { preparation } = event;
  const model = ctx.model!;
  const history = serializeConversation(
    convertToLlm(
      stripReferenceBodies(
        preparation.messagesToSummarize,
        references.documents,
      ),
    ),
  );
  const prefix = serializeConversation(
    convertToLlm(
      stripReferenceBodies(
        preparation.turnPrefixMessages,
        references.documents,
      ),
    ),
  );
  const prompt = render(text.summary.prompt, {
    previous: preparation.previousSummary ?? "",
    history,
    prefix,
    focus: event.customInstructions ?? "",
  });
  const signal = AbortSignal.any([event.signal, AbortSignal.timeout(300_000)]);
  const sessionId = uuidv7();
  const retry = SettingsManager.create(ctx.cwd).getRetrySettings();
  const response = await retryAssistantCall(
    () =>
      ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: text.summary.system,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens,
          signal,
          cacheRetention: "none",
          sessionId,
          ...(model.reasoning &&
          ctx.thinkingLevel &&
          ctx.thinkingLevel !== "off"
            ? { reasoning: ctx.thinkingLevel }
            : {}),
        },
      ),
    retry,
    signal,
  );
  const summary = contentText(response.content);
  if (signal.aborted) throw signal.reason;
  if (
    response.stopReason !== "stop" ||
    !summary.trim() ||
    response.content.some((block) => block.type === "toolCall")
  ) {
    throw new Error(response.errorMessage || text.errors.empty);
  }
  const modifiedFiles = [
    ...new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]),
  ].sort();
  const readFiles = [...preparation.fileOps.read]
    .filter((path) => !modifiedFiles.includes(path))
    .sort();
  return {
    summary:
      summary +
      render(text.summary.file_lists, {
        read: readFiles.join("\n"),
        modified: modifiedFiles.join("\n"),
      }),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: response.usage,
    details: { readFiles, modifiedFiles },
  };
}

export function registerCompaction(pi: ExtensionAPI): void {
  registerCompactionDisplay(pi);
  let system_files: string[] = [];
  pi.on("session_start", (_event, ctx) => {
    system_files = discoverAgentsPaths(ctx.cwd);
  });
  pi.on("before_agent_start", (event) => {
    system_files = (event.systemPromptOptions.contextFiles ?? []).map(
      (file) => file.path,
    );
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const text = loadText<CompactionText>("compaction", textPath("compaction"));
    try {
      if (event.branchEntries.length > 200_000)
        throw new Error("Compaction branch exceeds 200000 entries");
      const session_id = ctx.sessionManager.getSessionId();
      const branch_leaf = event.branchEntries.at(-1)?.id;
      const references = await collectReferences(event.branchEntries, {
        cwd: getCwd(),
        systemFiles: system_files,
        trusted: ctx.isProjectTrusted(),
      });
      let checkpoint = buildCheckpoint(references, collectRuntimeState(ctx));
      const result = await summarizeTask(
        event,
        ctx,
        references,
        summaryBudget(event, ctx, checkpoint, text, toolTokens(pi)),
        text,
      );
      if (event.signal.aborted) throw event.signal.reason;
      if (
        ctx.sessionManager.getSessionId() !== session_id ||
        ctx.sessionManager.getLeafId() !== branch_leaf
      ) {
        throw new Error(text.errors.changed);
      }
      checkpoint = buildCheckpoint(references, collectRuntimeState(ctx));
      if (
        estimateTokens({
          role: "user",
          content: result.summary,
          timestamp: 0,
        }) > summaryBudget(event, ctx, checkpoint, text, toolTokens(pi))
      ) {
        throw new Error(text.errors.budget);
      }
      return {
        compaction: {
          ...result,
          details: { ...result.details, cpiContext: checkpoint },
        },
      };
    } catch (error) {
      ctx.ui.notify(
        render(text.errors.failed, {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      return { cancel: true };
    }
  });
  pi.on("context", (event, ctx) => ({
    messages: projectCheckpoint(event.messages, ctx),
  }));
}

export default registerCompaction;
