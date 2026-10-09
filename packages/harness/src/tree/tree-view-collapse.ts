import type { HitRow } from "./tree-view-helpers.ts";
import type { TreeState } from "./tree-view-types.ts";

interface CollapseTarget {
  collapseLarge(): boolean;
}
const key = Symbol.for("cpi.tree-collapse.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: Map<TreeState, CollapseTarget>;
};
const targets = (shared[key] ??= new Map());
const MAX_TARGETS = 1024;

export function screenRows(): number {
  return process.stdout.rows || Number(process.env.LINES) || 24;
}

export function registerTreeCollapse(
  state: TreeState,
  target: CollapseTarget,
  active: boolean,
): void {
  targets.delete(state);
  if (!active) return;
  if (targets.size >= MAX_TARGETS) targets.delete(targets.keys().next().value!);
  targets.set(state, target);
}

export function unregisterTreeCollapse(
  state: TreeState,
  target: CollapseTarget,
): void {
  if (targets.get(state) === target) targets.delete(state);
}

export function resetTreeCollapse(): void {
  targets.clear();
}

export function collapseRecentTree(): boolean {
  const entries = [...targets.entries()]
    .reverse()
    .sort(
      ([a], [b]) => (b.lastExpansion?.at ?? 0) - (a.lastExpansion?.at ?? 0),
    );
  return entries.some(([, target]) => target.collapseLarge());
}

export function largeCollapseHit(
  hits: readonly HitRow[],
  state: TreeState,
): HitRow | undefined {
  const recent = state.lastExpansion;
  const match = hits.find(
    (hit) =>
      hit.large &&
      recent?.id === hit.id &&
      recent.body === (hit.kind === "body-toggle"),
  );
  if (match) return match;
  for (let index = hits.length - 1; index >= 0; index--)
    if (hits[index]!.large) return hits[index];
  return undefined;
}

export function collapseTreeHit(hit: HitRow, state: TreeState): void {
  if (hit.kind === "body-toggle")
    (state.fullBodies ??= new Map()).set(hit.id, false);
  else state.open.set(hit.id, false);
}
