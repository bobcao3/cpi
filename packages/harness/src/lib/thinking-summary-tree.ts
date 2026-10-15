import type {
  Theme,
  ThinkingRenderOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { toolTreeTicker } from "../presentation/registry.ts";
import { TreeView, type TreeNode } from "../tree/tree-view.ts";
import { createTreeState } from "../tree/tree-view-state.ts";
import { shortest_title_mutations } from "./thinking-title-mutations.ts";

const max_transition_frames = 3;

export interface ThinkingSection {
  title: string;
  summary: string;
}

export class ThinkingSummaryTree {
  readonly tree: TreeView;
  private readonly state = createTreeState();
  private sections: readonly ThinkingSection[];
  private options: ThinkingRenderOptions;
  private theme: Theme;
  private title: string;
  private target: string;
  private mutations: readonly string[] = [];
  private mutation_index = 0;
  private mutation_stride = 1;

  constructor(
    sections: readonly ThinkingSection[],
    options: ThinkingRenderOptions,
    theme: Theme,
  ) {
    this.sections = sections;
    this.options = options;
    this.theme = theme;
    this.title = sections.at(-1)?.title ?? "Summary";
    this.target = this.title;
    this.state.expanded = options.expanded;
    this.tree = new TreeView(this.project(), {
      state: this.state,
      theme: { guide: (text) => this.theme.fg("muted", text) },
      requestRender: () => this.options.requestRender(),
    });
  }

  update(
    sections: readonly ThinkingSection[],
    options: ThinkingRenderOptions,
    theme: Theme,
  ): void {
    this.sections = sections;
    this.options = options;
    this.theme = theme;
    this.state.expanded = options.expanded;
    const target = sections.at(-1)?.title ?? "Summary";
    if (!options.isStreaming || this.is_open()) {
      this.target = target;
      this.finish();
    } else if (target !== this.target) {
      this.target = target;
      this.mutations = shortest_title_mutations(this.title, target);
      this.mutation_index = 0;
      this.mutation_stride = Math.max(
        1,
        Math.ceil(this.mutations.length / max_transition_frames),
      );
      if (this.mutations.length) toolTreeTicker.register(this);
    }
    this.tree.update(this.project());
  }

  needsAnimation(): boolean {
    if (this.is_open()) {
      this.finish();
      this.tree.update(this.project());
    }
    if (!this.mutations.length) toolTreeTicker.unregister(this);
    return this.mutations.length > 0;
  }

  tick(): void {
    this.mutation_index = Math.min(
      this.mutations.length,
      this.mutation_index + this.mutation_stride,
    );
    this.title = this.mutations[this.mutation_index - 1] ?? this.target;
    if (this.mutation_index === this.mutations.length) this.finish();
    this.tree.update(this.project());
  }

  private is_open(): boolean {
    return Boolean(this.state.open.get("thinking") ?? this.state.expanded);
  }

  private finish(): void {
    this.title = this.target;
    this.mutations = [];
    toolTreeTicker.unregister(this);
  }

  private project(): readonly TreeNode[] {
    const muted = (text: string) => this.theme.fg("muted", text);
    const markdown_theme: MarkdownTheme = {
      ...this.options.markdownTheme,
      heading: muted,
      link: muted,
      linkUrl: muted,
      code: muted,
      codeBlock: muted,
      codeBlockBorder: muted,
      quote: muted,
      quoteBorder: muted,
      hr: muted,
      listBullet: muted,
      italic: (text) => text,
      highlightCode: undefined,
    };
    return [
      {
        id: "thinking",
        label: muted(this.theme.bold("Thinking")),
        collapsedLabel: muted(`${this.theme.bold("Thinking")}: ${this.title}`),
        icon: "💡",
        defaultOpen: false,
        children: this.sections.map((section, index) => ({
          id: `thinking/${index}`,
          label: muted(this.theme.bold(section.title)),
          defaultOpen: false,
          body: section.summary.trim()
            ? new Markdown(
                section.summary.trim(),
                0,
                0,
                markdown_theme,
                { color: muted },
                { transform: this.options.transform },
              )
            : undefined,
        })),
      },
    ];
  }
}
