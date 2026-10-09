import {
  contentText,
  retryAssistantCall,
  uuidv7,
  type AssistantMessage,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
  sessionEntryToContextMessages,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { discoverAgentsPaths } from "./agents.ts";
import { getCwd } from "./cwd.ts";
import { registerCompactionDisplay } from "./compaction-display.ts";
import {
  collectReferences,
  stripReferenceBodies,
  type ReferenceBundle,
} from "./compaction-references.ts";
import {
  beginCompaction,
  finishCompaction,
  reportCompactionTokens,
} from "./compaction-progress.ts";
import { collectRuntimeState } from "./compaction-state.ts";
import {
  buildCheckpoint,
  projectCheckpoint,
  type ContextCheckpoint,
} from "./compaction-checkpoint.ts";
import { loadText, render, textPath } from "./text.ts";

type CompactionText = {
  summary: {
    system: string;
    prompt: string;
    tool_name: string;
    tool: { description: string };
    schema: { summary: string; relevant_skills: string };
    file_lists: string;
    selected_skills: string;
  };
  errors: {
    failed: string;
    budget: string;
    empty: string;
    invalid: string;
    changed: string;
  };
};

type SummaryFields = { summary: string; relevant_skills: string[] };

function validateSummary(
  value: unknown,
  skills: readonly Skill[],
  invalid: string,
): SummaryFields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(invalid);
  const result = value as Record<string, unknown>;
  const names = new Set(skills.map((skill) => skill.name));
  if (
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.relevant_skills) ||
    result.relevant_skills.length > skills.length ||
    result.relevant_skills.some(
      (name) => typeof name !== "string" || !names.has(name),
    ) ||
    new Set(result.relevant_skills).size !== result.relevant_skills.length
  )
    throw new Error(invalid);
  return {
    summary: result.summary,
    relevant_skills: result.relevant_skills as string[],
  };
}

export function parseSkillSummary(
  output: string,
  skills: readonly Skill[],
  invalid: string,
): SummaryFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(invalid);
  }
  return validateSummary(parsed, skills, invalid);
}

function summaryTool(text: CompactionText): Tool {
  return {
    name: text.summary.tool_name,
    description: text.summary.tool.description,
    parameters: Type.Object({
      summary: Type.String({ description: text.summary.schema.summary }),
      relevant_skills: Type.Array(Type.String(), {
        description: text.summary.schema.relevant_skills,
      }),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
}

function readSummary(
  response: AssistantMessage,
  skills: readonly Skill[],
  tool_name: string,
  text: CompactionText,
): SummaryFields {
  const call = response.content.find(
    (block): block is ToolCall =>
      block.type === "toolCall" && block.name === tool_name,
  );
  if (call) return validateSummary(call.arguments, skills, text.errors.invalid);
  const output = contentText(response.content);
  if (response.stopReason !== "stop" || !output.trim())
    throw new Error(response.errorMessage || text.errors.empty);
  return parseSkillSummary(output, skills, text.errors.invalid);
}

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
  const summary_reserve = Math.max(preparation.settings.reserveTokens, 16_384);
  const available =
    model.contextWindow -
    summary_reserve -
    restoration -
    kept.reduce((total, message) => total + estimateTokens(message), 0) -
    system -
    tools_tokens -
    1024;
  const budget = Math.floor(
    Math.min(0.8 * summary_reserve, model.maxTokens || Infinity, available),
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
  skills: Skill[],
  maxTokens: number,
  text: CompactionText,
) {
  const { preparation } = event;
  const model = ctx.model!;
  const tool = summaryTool(text);
  const history = serializeConversation(
    convertToLlm(
      stripReferenceBodies(
        preparation.messagesToSummarize,
        references.documents,
        true,
        skills,
      ),
    ),
  );
  const prefix = serializeConversation(
    convertToLlm(
      stripReferenceBodies(
        preparation.turnPrefixMessages,
        references.documents,
        true,
        skills,
      ),
    ),
  );
  const prompt = render(text.summary.prompt, {
    previous: preparation.previousSummary ?? "",
    history,
    prefix,
    focus: event.customInstructions ?? "",
    tool_name: tool.name,
    skills: JSON.stringify(
      skills.map(({ name, description }) => ({ name, description })),
    ),
  });
  const signal = AbortSignal.any([event.signal, AbortSignal.timeout(300_000)]);
  const sessionId = uuidv7();
  const retry = SettingsManager.create(ctx.cwd).getRetrySettings();
  const produce = async () => {
    const stream = ctx.modelRegistry.stream(
      model,
      {
        systemPrompt: render(text.summary.system, { tool_name: tool.name }),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      },
      {
        maxTokens,
        signal,
        cacheRetention: "none",
        sessionId,
        ...(model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off"
          ? { reasoning: ctx.thinkingLevel }
          : {}),
      },
    );
    beginCompaction();
    try {
      for await (const streamEvent of stream) {
        if ("partial" in streamEvent)
          reportCompactionTokens(estimateTokens(streamEvent.partial));
      }
      return await stream.result();
    } finally {
      finishCompaction();
    }
  };
  const response = await retryAssistantCall(produce, retry, signal);
  if (signal.aborted) throw signal.reason;
  const { summary, relevant_skills } = readSummary(
    response,
    skills,
    tool.name,
    text,
  );
  const modifiedFiles = [
    ...new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]),
  ].sort();
  const readFiles = [...preparation.fileOps.read]
    .filter((path) => !modifiedFiles.includes(path))
    .sort();
  return {
    summary:
      summary +
      (relevant_skills.length
        ? render(text.summary.selected_skills, {
            names: relevant_skills.join(", "),
          })
        : "") +
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
  let available_skills: Skill[] = [];
  pi.on("session_start", (_event, ctx) => {
    system_files = discoverAgentsPaths(ctx.cwd);
  });
  pi.on("before_agent_start", (event) => {
    system_files = (event.systemPromptOptions.contextFiles ?? []).map(
      (file) => file.path,
    );
    available_skills = (event.systemPromptOptions.skills ?? []).filter(
      (skill: Skill) => !skill.disableModelInvocation,
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
        available_skills,
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
