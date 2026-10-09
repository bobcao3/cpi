import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import alarm from "./alarm.ts";
import codemode from "./codemode.ts";
import { register_tree_renderers } from "./lib/tool-tree.ts";
import { tree_extension_api } from "./lib/tree-api.ts";
import core from "./core.ts";
import costTree from "./cost-tree/index.ts";
import cwd from "./cwd.ts";
import fast from "./fast.ts";
import goal from "./goal.ts";
import llmEditor from "./llm-editor/index.ts";
import lsp from "./lsp.ts";
import onboarding from "./onboarding.ts";
import providerUsage from "./provider-usage.ts";
import provider from "./provider.ts";
import shell from "./shell.ts";
import subagentModels from "./subagent-models.ts";
import subagentTranscript from "./subagent-transcript/index.ts";
import waitAny from "./wait-any.ts";

export default async function cpi(host: ExtensionAPI): Promise<void> {
  const pi = tree_extension_api(host);
  register_tree_renderers(pi);
  const extensionFactories: ExtensionFactory[] = [
    alarm,
    core,
    costTree,
    cwd,
    fast,
    goal,
    llmEditor,
    lsp,
    onboarding,
    providerUsage,
    provider,
    shell,
    subagentModels,
    subagentTranscript,
    waitAny,
    codemode,
  ];
  for (const factory of extensionFactories) await factory(pi);
}
