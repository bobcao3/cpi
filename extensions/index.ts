import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import alarm from "./alarm.ts";
import codemode from "./codemode.ts";
import { with_record_renderers } from "./lib/tool-block.ts";
import type { ToolRenderers } from "./codemode/preview.ts";
import core from "./core.ts";
import costTree from "./cost-tree/index.ts";
import cwd from "./cwd.ts";
import fast from "./fast.ts";
import goal from "./goal.ts";
import llmEditor from "./llm-editor/index.ts";
import lsp from "./lsp.ts";
import providerUsage from "./provider-usage.ts";
import provider from "./provider.ts";
import shell from "./shell.ts";
import subagentModels from "./subagent-models.ts";
import subagentTranscript from "./subagent-transcript/index.ts";
import vcsJj from "./vcs-jj/index.ts";
import waitAny from "./wait-any.ts";

export default async function cpi(pi: ExtensionAPI): Promise<void> {
  const renderers: ToolRenderers = new Map();
  const api: ExtensionAPI = {
    ...pi,
    registerTool(tool) {
      renderers.set(tool.name, tool);
      pi.registerTool(with_record_renderers(tool));
    },
  };
  const extensionFactories: ExtensionFactory[] = [
    alarm,
    core,
    costTree,
    cwd,
    fast,
    goal,
    llmEditor,
    lsp,
    providerUsage,
    provider,
    shell,
    subagentModels,
    subagentTranscript,
    vcsJj,
    waitAny,
    (api) => codemode(api, renderers),
  ];
  for (const factory of extensionFactories) await factory(api);
}
