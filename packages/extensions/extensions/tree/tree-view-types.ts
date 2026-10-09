import type { Component } from "@earendil-works/pi-tui";

export type TreeStatus =
  | "queued"
  | "running"
  | "success"
  | "warning"
  | "error"
  | "cancelled"
  | "paused"
  | "detached";

export interface TreeNode {
  id: string;
  label: string;
  summary?: string;
  metadata?: readonly string[];
  status?: TreeStatus;
  children?: readonly TreeNode[];
  body?: Component;
  defaultOpen?: boolean;
  surface?: {
    background: (text: string) => string;
    edge?: (position: "top" | "bottom", width: number) => string;
  };
}

export interface TreeState {
  open: Map<string, boolean>;
  shownChildren: Map<string, number>;
  selectedId?: string;
  expanded?: boolean;
  frame?: number;
}

export interface TreeViewTheme {
  guide?: (text: string) => string;
  status?: (text: string, status: TreeStatus) => string;
  selected?: (text: string) => string;
}

export interface TreeViewOptions {
  state?: TreeState;
  theme?: TreeViewTheme;
  requestRender?: () => void;
  onCancel?: () => void;
  onSelectionChange?: (id: string) => void;
}
