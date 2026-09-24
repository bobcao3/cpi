import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import alarm from "./alarm.ts";
import core from "./core.ts";
import costTree from "./cost-tree/index.ts";
import cwd from "./cwd.ts";
import effort from "./effort.ts";
import fast from "./fast.ts";
import goal from "./goal.ts";
import llmEditor from "./llm-editor/index.ts";
import lsp from "./lsp.ts";
import openAICodexUsage from "./openai-codex-usage.ts";
import provider from "./provider.ts";
import shell from "./shell.ts";
import subagentModels from "./subagent-models.ts";
import subagentTranscript from "./subagent-transcript/index.ts";
import vcsJj from "./vcs-jj/index.ts";
import waitAny from "./wait-any.ts";

export default async function cpi(pi: ExtensionAPI): Promise<void> {
  const extensionFactories: ExtensionFactory[] = [
    alarm,
    core,
    costTree,
    cwd,
    effort,
    fast,
    goal,
    llmEditor,
    lsp,
    openAICodexUsage,
    provider,
    shell,
    subagentModels,
    subagentTranscript,
    vcsJj,
    waitAny,
  ];
  for (const factory of extensionFactories) await factory(pi);
}
