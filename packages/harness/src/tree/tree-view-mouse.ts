import {
  dispatchMouseEvent,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { HitRow } from "./tree-view-helpers.ts";
import type { TreeState } from "./tree-view-types.ts";
import { markExpansion } from "./tree-view-state.ts";

export function dispatchTreeMouse(
  hits: readonly HitRow[],
  event: TuiMouseEvent,
  state: TreeState,
  actions: {
    canFocus: boolean;
    canExpand: (id: string) => boolean;
    toggle: (id: string) => void;
    more: (id: string) => void;
    collapse: (hit: HitRow) => void;
    select: (id: string) => void;
    changed: () => void;
  },
): TuiMouseEventResult | undefined {
  if (event.type === "wheel" || event.type === "drag" || event.type === "move")
    return undefined;
  const hit = hits.find((row) => event.y === row.y);
  if (!hit) return undefined;
  if (hit.kind === "body")
    return dispatchBodyMouse(hit, event, actions.canFocus);
  if (
    event.button !== "left" ||
    (event.type !== "press" && event.type !== "click")
  )
    return undefined;
  if (
    hit.kind === "more" ||
    hit.kind === "body-toggle" ||
    hit.kind === "collapse"
  ) {
    if (event.type === "click") {
      if (hit.kind === "more") actions.more(hit.id);
      else if (hit.kind === "collapse") actions.collapse(hit);
      else {
        const full = state.fullBodies?.get(hit.id) ?? Boolean(state.expanded);
        (state.fullBodies ??= new Map()).set(hit.id, !full);
        if (!full) markExpansion(state, hit.id, true);
        actions.changed();
      }
    }
    return {
      handled: true,
      render: event.type === "click",
      focus: actions.canFocus,
    };
  }
  const onMarker = event.x >= hit.markerStart && event.x < hit.markerEnd;
  if (onMarker && actions.canExpand(hit.id)) {
    if (event.type === "click") actions.toggle(hit.id);
    return { handled: true, focus: actions.canFocus };
  }
  if (event.type === "press") return undefined;
  actions.select(hit.id);
  return { handled: true, focus: actions.canFocus };
}

export function dispatchBodyMouse(
  hit: HitRow,
  event: TuiMouseEvent,
  canFocus: boolean,
): TuiMouseEventResult | undefined {
  if (
    !hit.body ||
    hit.bodyY === undefined ||
    hit.bodyWidth === undefined ||
    event.x < hit.markerEnd ||
    event.x >= hit.markerEnd + hit.bodyWidth
  )
    return undefined;
  const result = dispatchMouseEvent(hit.body, {
    ...event,
    x: event.x - hit.markerEnd,
    y: hit.bodyY,
    width: hit.bodyWidth,
    height: hit.bodyHeight ?? event.height,
  });
  return result ? { ...result, focus: result.focus && canFocus } : undefined;
}
