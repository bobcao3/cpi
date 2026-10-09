import type { ToolRenderers } from "../renderer-types.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type { ToolRenderers };
export {
  createShellRenderers,
  editRenderers,
  findRenderers,
  grepRenderers,
  lsRenderers,
  readRenderers,
  writeRenderers,
};

export function createAllToolRenderers(): Record<string, ToolRenderers> {
  return {
    read: readRenderers,
    bash: createShellRenderers("$"),
    powershell: createShellRenderers("PS>"),
    edit: editRenderers,
    write: writeRenderers,
    grep: grepRenderers,
    find: findRenderers,
    ls: lsRenderers,
  };
}

export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
  toolName: string,
  definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
  const builtIn = createAllToolRenderers()[toolName];
  if (!definition) return builtIn;
  if (!builtIn) return definition;
  return {
    ...definition,
    renderTree:
      definition.renderTree ??
      (definition.renderCall || definition.renderResult
        ? undefined
        : builtIn.renderTree),
    renderCall: definition.renderCall ?? builtIn.renderCall,
    renderResult: definition.renderResult ?? builtIn.renderResult,
  };
}
