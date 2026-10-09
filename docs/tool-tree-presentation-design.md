# Historical tool-tree rendering proposal

Status: historical proposal. The proposed Pi-owned tree APIs and example
migrations below were rejected. The [cpi package boundary](package-boundary.md)
defines current ownership.

This document records the earlier rendering requirements and migration survey.
Keep tree implementation and presentation policy in cpi, not in Pi packages.

[Decision](#decision) ·
[Problem and example](#problem-and-concrete-example) ·
[Survey and migration targets](#survey-and-migration-targets) ·
[Shared layout contract](#shared-layout-contract) ·
[Primitive and presentation API](#primitive-and-presentation-api) ·
[Identity, expansion, and ordering](#identity-expansion-and-ordering) ·
[Keyboard, mouse, and scrolling](#keyboard-mouse-and-scrolling) ·
[Status ticker and lifecycle](#status-ticker-and-lifecycle) ·
[Content limits, safety, and export](#content-limits-safety-and-export) ·
[Implementation order](#implementation-order) ·
[Verification plan](#verification-plan) ·
[References](#references)

## Decision

Add one multi-root `TreeView` to `@earendil-works/pi-tui`. Add a semantic tool-tree presentation contract to `@earendil-works/pi-coding-agent`. Tools provide labels, summaries, statuses, content, and parent-child relationships. The shared renderer owns indentation, connectors, wrapping, disclosure controls, hit regions, selection, and animation.

Use the same tool presentation resolver for direct calls, nested calls, restored sessions, and exports. Keep specialized content renderers for diffs, source code, Markdown, images, and visual tools. Specialized content does not own the surrounding tree layout.

A forest means an ordered list of independent root nodes. A logical row means one node header, even when the terminal wraps the header across several physical lines. Every logical row with children or detail content can expand independently. Physical continuation lines belong to their logical row; continuation lines do not acquire separate expansion state.

## Problem and concrete example

The current code has several independent presentation systems:

- [`ObjectTreeComponent`](../../cpi-fork/packages/coding-agent/src/modes/interactive/components/object-tree.ts) renders one JSON-oriented root and supports mouse expansion at individual disclosure markers. The component has no keyboard navigation or multi-root API.
- [`ToolExecutionComponent`](../../cpi-fork/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) composes separate call and result components. The host exposes one `expanded` boolean and adds click-to-toggle regions around both components.
- cpi's [`record_block`](../packages/harness/src/lib/tool-block.ts) handles padding, entry wrapping, and mouse-coordinate translation.
- cpi's [code-mode rendering](../packages/harness/src/codemode/calls.ts) invokes registered child renderers directly, groups reads and writes separately, and falls back to another object tree.
- cpi's [shell rendering](../packages/harness/src/shell/compact-render.ts) owns an elapsed-time interval. [Code-mode stdout](../packages/harness/src/codemode/stdout.ts) owns another disclosure implementation.

For example, a code-mode script can read two files, edit one file, and start a background shell. The current presentation combines comma-separated read summaries, an always-visible framed diff, a compact shell summary, and independently implemented output disclosure. The parent expansion flag also controls several child previews. A renderer wrapper cannot make these components share node identity, keyboard navigation, or content ownership.

The proposed presentation gives the script, calls, edit diff, process details, and output separate node identities. A user can inspect one failed edit while leaving sibling reads and shell output collapsed. Streaming updates change data without resetting the user's choices.

An illustrative view uses `R` for a running ticker, `+` for success, and `!` for failure. Actual rendering uses equal-width themed indicators. The second tool is an independent root:

```text
R v codemode                         1 running, 1 failed
  ├─ > Script                        JavaScript, 12 lines
R ├─ v Calls                         3 calls
+ │  ├─ > read alpha.ts              24 lines
! │  ├─ v apply_patch beta.ts        1 hunk applied before failure
  │  │  └─ > Diff and failure detail
R │  └─ > sh                         Run focused checks
  └─ > Output
+ > set_cwd                          /workspace
```

## Survey and migration targets

The survey covers maintained cpi tool renderers, the fork's tool-rendering infrastructure and built-in renderers, and extension examples. Tests and generated artifacts are not production renderer targets. Paths prefixed with `cpi:` refer to `/home/bob/cpi`; other source paths refer to `/home/bob/cpi-fork`.

### cpi production renderers

The cpi extension has custom renderers for 14 named tools, plus a resolver for MCP and otherwise uncustomized tools.

| Tools | Current presentation sources | Proposed presentation and behavior to preserve |
| --- | --- | --- |
| `read` | `cpi:packages/harness/src/llm-editor/read-render.ts`, `read-batch.ts` | One row per call, optionally under a batch parent. Preserve file links, query text, returned ranges, line counts, directory/image/video classifications, and errors. Grouping must not make individual files inaccessible. |
| `write`, `edit`, `apply_patch` | `cpi:packages/harness/src/llm-editor/render.ts`, `write-record.ts` | An action row with independently expandable diff, failure details, and editor transcript. Preserve old/new line numbers, creation bytes, hunk counts, whole-file rewrite indicators, and applied changes before failure. Keep diff previews visible under the initial compact policy until a visibility change is approved. |
| `sh` | `cpi:packages/harness/src/shell.ts`, `shell/compact-render.ts`, `shell/blocked.ts` | A command row with description and timing; detail nodes for command, exit/error, warnings, and background-process metadata. Preserve compact success output. Do not retain successful nested stdout merely to make expansion possible. |
| `sh_repeat_until` | `cpi:packages/harness/src/shell/repeat-tool.ts`, `repeat-render.ts` | A monitor-launch row with a process/detail child. Preserve monitor ID, interval, stop condition, warnings, and blocked/error states. |
| `sh_signal`, `sh_detach` | `cpi:packages/harness/src/shell/background-tools.ts`, `compact-render.ts` | One operation row with target and outcome. Preserve process/monitor distinctions, signal, description, detached state, and log-path detail. A sent signal does not prove process termination. |
| `sh_background_ps` | The same background-tool sources | A list parent with one process/monitor child per entry. Replace manually constructed connectors. Preserve identifiers and repeating indicators. The list describes a snapshot unless the adapter explicitly subscribes to live activity. |
| `lsp` | `cpi:packages/harness/src/lsp.ts`, `lsp-render.ts` | Command-specific children for diagnostics, sessions, and supported servers. Preserve severity, positions, language, and server state. A completed check with diagnostics differs from a failed tool execution. |
| `alarm` | `cpi:packages/harness/src/alarm.ts` | An operation row with alarm ID, absolute time, relative-time summary, and message detail. Distinguish successful scheduling from the alarm's later firing. Preserve missing-alarm and cancellation outcomes. |
| `set_cwd` | `cpi:packages/harness/src/cwd.ts` | A directory-change row with linked project-instruction children and failure detail. Preserve the logical directory and newly discovered instruction files. |
| `wait_any` | `cpi:packages/harness/src/wait-any.ts` | A paused/waiting row with the recorded timestamp and error detail. Do not animate a completed waiting request indefinitely. |
| `codemode` | `cpi:packages/harness/src/codemode/render.ts`, `calls.ts`, `stdout.ts`, `preview.ts` | A tool root with independently expandable script, nested-call, output, attachment, and notice sections. Preserve source line numbers, durations, costs, output formatting, and metadata/full-output notices. Children use the normal presentation resolver. |
| MCP and generic fallback | `cpi:packages/harness/src/lib/tool-tree.ts` | A tool root with arguments, result, text, attachments, and notices. Preserve `server/tool` labels, explicit custom-renderer precedence, resumed MCP rendering, structured scalar types, and full-output paths. |

[`src/index.ts`](../packages/harness/src/index.ts) currently wraps custom tools through `with_record_renderers` and keeps a separate renderer map for code mode. The migration replaces both layout mechanisms with the core tree host and resolver. Tool execution behavior remains unchanged.

`sh_screenshot` has no custom renderer; the generic resolver handles the call. The tree adapter must preserve screenshot metadata and the image without printing binary payloads. `shell/render.ts` contains a separate verbose shell renderer, but the surveyed production registration uses `compact-render.ts`. Do not delete the verbose renderer as part of migration without checking intended use and obtaining approval.

### Fork renderers and examples

| Sources | Migration |
| --- | --- |
| `packages/coding-agent/src/extensions/mcp/tools.ts` and `mcp/index.ts` | Use the generic tool-tree adapter and retain resolver support before a server reconnects. Preserve text/image handling, truncation notices, and full-output references. |
| `packages/coding-agent/src/extensions/codemode/renderer.ts` | Use the same script/call/output sections as cpi, with tool-specific compact defaults. Preserve nested status, duration, cost, errors, and output type metadata. |
| `packages/coding-agent/src/core/tools/renderers/{bash,read,write,edit,find,grep,ls}.ts` | Migrate the surrounding call/result presentation. Preserve syntax highlighting, resource-read classifications, truncation information, search parameters/results, and diff previews. The built-in edit renderer starts asynchronous preview work before execution; the migration must retain preview behavior under host-owned lifecycle management. |
| `packages/coding-agent/examples/extensions/built-in-tool-renderer.ts`, `minimal-mode.ts` | Demonstrate semantic customization and compact policies instead of custom wrapping. Minimal mode may still omit successful result previews. |
| `packages/coding-agent/examples/extensions/truncated-tool.ts` | Search row with count, results, truncation warning, and full-output reference. |
| `packages/coding-agent/examples/extensions/todo.ts`, `structured-output.ts` | Item/action children with domain-specific summaries. Preserve todo IDs/completion styling, headlines, summaries, and numbered actions. |
| `packages/coding-agent/examples/extensions/question.ts`, `questionnaire.ts` | Migrate transcript question/answer summaries only. Preserve choices, custom answers, and cancellation. Keep the actual interactive dialogs specialized. |
| `packages/coding-agent/examples/extensions/subagent/index.ts` | Agent/task children for single, chain, and parallel execution. Preserve nested transcript content, Markdown answers, per-agent state, and usage summaries. |
| `packages/coding-agent/examples/extensions/tic-tac-toe.ts` | Use a normal action/status row and retain the board as specialized content. Preserve cursor, winning-line, and board rendering. |

`tool-override.ts` mentions rendering but defines no custom renderer. No additional TUI tool renderers were found in the standalone `packages/mcp` or `packages/codemode` libraries; coding-agent owns their transcript presentation.

### Related surfaces that should not become tool trees automatically

- cpi's `subagent-transcript/index.ts`, `lib/transcript-registry.ts`, and `shell/transcript.ts` produce append-only Markdown, not interactive components. Share semantic summaries where practical, but retain call/result correlation and the print output contract.
- cpi's `bin/subagent-display.mjs` invokes call/result renderers with bounded plain output. Update this consumer to the semantic contract when production renderers migrate; terminal animation and focus must remain disabled.
- The activity panel, cost tree, session tree selector, custom messages, widgets, and interactive dialogs have separate navigation or workflow semantics. They may reuse `TreeView` later, but the initial scope does not replace those interfaces.

## Shared layout contract

Every physical line reserves a leading status column. Node headers show a status indicator when the node has status; continuation and body lines leave the status column blank. After the status column, the renderer places tree guides, a disclosure control, the label, an optional summary, and metadata.

The renderer must:

1. Render a forest without adding a visible artificial root. Root ordering follows the supplied data.
2. Compute connectors from visible siblings, including pagination/notice rows. Tools never supply branch glyphs or indentation strings.
3. Reserve a fixed-width status cell and disclosure cell. Spinner frames, success/error indicators, and ASCII fallbacks must occupy the same terminal width.
4. Measure terminal columns with the existing ANSI/Unicode utilities. Every returned line must fit the supplied width, including widths of zero or one.
5. Prioritize the disclosure control and label. Metadata moves to a continuation line when metadata cannot fit; metadata must not erase the label.
6. Keep a compact summary on closed rows. Expanded detail content wraps beneath the row's text column. If a header itself cannot fit, the renderer uses a bounded header preview; expansion exposes the complete header as detail content.
7. Align continuation lines automatically. The renderer computes sibling field alignment locally, bounds alignment padding, and avoids a whole-document width scan.
8. Reduce displayed guide depth at narrow widths while preserving actual parent relationships. A shortened guide never changes node identity or keyboard navigation.
9. Apply tool padding once at the outer host. Nested adapters receive their allocated content width and do not add another outer shell.
10. Create hit regions from the same layout result used to draw lines. Resize, wrapped labels, and pagination must not leave stale click coordinates.

Default tool formatting remains compact. The shared layout does not require every tool to expose raw arguments or successful stdout in the initial view. Domain adapters choose content and initial visibility; adapters do not choose spacing, controls, or interaction behavior.

## Primitive and presentation API

The terminal primitive needs a small API. The following names and types are proposed, not existing exports:

```typescript
import type { Component } from "@earendil-works/pi-tui";

type TreeStatus =
  | "queued" | "running" | "success" | "warning" | "error"
  | "cancelled" | "paused" | "detached";

interface TreeNode {
  id: string;
  label: string;
  summary?: string;
  metadata?: readonly string[];
  status?: TreeStatus;
  children?: readonly TreeNode[];
  body?: Component;
  defaultOpen?: boolean;
}

interface TreeState {
  open: Map<string, boolean>;
  shownChildren: Map<string, number>;
  selectedId?: string;
}
```

`TreeView` accepts `readonly TreeNode[]`, a host-owned `TreeState`, injected styling, action matching, and render requests. `update(roots)` reconciles data without replacing interaction state. `reveal(id)` exposes the selected node's ancestors and reports the node's layout position to the host. The view owns neither a terminal nor a scroll container. Hosts compose the view with the existing `ScrollView` when a bounded viewport is needed.

The host retains body instances and layout caches by node ID and content revision. Collapsing a node does not dispose its retained state. Removing a forest detaches its input targets, releases retained bodies, and unregisters animation/subscriptions through one host-owned lifecycle path.

Terminal labels may contain trusted presentation ANSI produced by an adapter. Adapters sanitize external data before styling. The TUI primitive does not import coding-agent theme tokens, tool schemas, or execution code.

Coding-agent adds `renderTree(snapshot, context)` to the tool presentation contract. The hook returns a semantic forest rather than terminal lines. The snapshot supplies partial arguments, execution phase, current/final result, error state, duration, and available nested-call records. The context supplies the call ID, directory, tool-specific presentation state, and invalidation. The host owns expansion state separately.

Semantic nodes mirror the header fields above, but use theme-role text spans and typed content: plain text, source code, Markdown, diff, image, or custom content. Coding-agent converts semantic nodes into terminal nodes or HTML. A custom content body supplies a `Component` and a plain-text fallback; custom content may supply an HTML renderer. A custom body is not another tool shell.

Use existing content components and diff implementations rather than implementing another highlighter or Markdown parser. Renderers are synchronous projections of available state. The host owns preview jobs, subscriptions, and cleanup; render hooks do not start timers, read files, or execute tools.

The renderer resolver selects semantic rendering first, explicit specialized component rendering second, and generic tree rendering last. Explicit custom renderers must not be silently replaced. Existing call/result hooks remain an intentional escape hatch during staged migration, not a compatibility layer that emulates the old API forever.

## Identity, expansion, and ordering

The host asserts unique node IDs within a forest and rejects cycles or excessive model size with a visible rendering notice. IDs do not derive from labels, array display indices, completion order, or screen coordinates.

Tool nodes use execution call IDs. Section IDs derive from the owning call ID and stable section names. Nested calls retain their own execution IDs. Object fields use escaped property paths under their owning node. Collection items use domain IDs when available; an index is valid only for an immutable ordered snapshot.

A local toggle changes one entry in `TreeState.open`. Collapsing a parent hides descendants but retains descendant expansion choices. Content updates, status changes, theme changes, and resizes do not clear expansion or selection. If a selected node disappears, the view selects the nearest surviving ancestor or neighboring row.

The application-level `app.tools.expand` action remains an explicit bulk compact/detailed command. Only that explicit command applies the selected visibility preset and clears local overrides. Repeated renders or assignment of the same preset do not reset individual rows. Adapter defaults preserve current intentional compact behavior during migration.

A collapsed node reports relevant hidden activity or failures in its summary, for example `2 running, 1 failed`. A parent aggregate indicator describes children; the tool's own execution outcome remains separately identifiable. The adapter computes domain aggregates, and the tree renderer displays them.

Use stable invocation order for nested calls and grouped children. Completion updates replace a row in place. Batch grouping uses explicit parent nodes and retains every member's identity. The host owns a group once; follower tool components do not hide themselves through a global renderer registry. Do not reorder unrelated calls merely to group tools with matching names.

Forward execution events carrying `parentToolCallId` into the owning tool's transient presentation state instead of dropping nested events or creating duplicate transcript entries. Merge live events, final `nestedCalls`, and code-mode preview records by call ID. Preserve parent relationships from execution events and the assigned hierarchical IDs. Stored nested-call records do not contain results; use retained tool-specific previews when available and otherwise render a summary with unavailable-detail notices. Code-mode model-call rows retain their usage/cost metadata without pretending to be registered tools.

## Keyboard, mouse, and scrolling

The initial release must support per-node keyboard interaction, including regular terminal mode where mouse reporting is unavailable.

Add configurable application actions for entering/leaving tool inspection, moving between visible rows, opening/closing a row, toggling a row, and moving between tool roots. Put defaults in the existing keybinding definitions and generate hints from configured actions. Do not hardcode key comparisons in adapters.

In inspection mode, Up/Down select visible logical rows. Right opens a row or moves to its first visible child. Left closes a row or moves to its parent. Enter/Space toggles an expandable row. Escape leaves inspection and restores editor focus before the application processes an abort action. These keys do not replace editor behavior outside inspection mode.

The host routes inspection input across tool forests, retains focus while the view updates, and scrolls the selected row into view. Fullscreen uses the transcript `ScrollView`. Regular mode provides a tree inspector through the existing custom-screen mechanism, using the same data and expansion state; regular mode must not pretend terminal-owned scrollback is an application viewport.

Mouse clicks on disclosure controls toggle the corresponding logical row. A click on an ordinary label may select the row but must not toggle a whole tool or suppress an OSC 8 link. Non-control text remains available for transcript selection; unhandled drags and wheel events reach existing selection/scroll handlers. Custom bodies receive translated coordinates only inside their allocated region.

For semantic trees, `ToolExecutionComponent` must not install its current whole-component click-to-toggle wrapper. The host delegates input to the tree view. Preserve the selected node's screen anchor during expansion and streaming updates when the user has disabled follow-end behavior.

## Status ticker and lifecycle

Status indicators belong to rows, not to tool-specific strings. Running nodes use a shared spinner clock. Non-running nodes use static indicators. Rows without status keep an empty status cell. Status must remain distinguishable without color.

The application owns one animation scheduler and coalesces redraw requests. The host supplies visible/mounted tree ranges. The scheduler animates visible running headers and visible collapsed ancestors that summarize running descendants, without allocating timers per node. Cache body layout independently so a spinner frame does not re-highlight code or rebuild diffs. Elapsed-time text updates less frequently than spinner frames and uses host-provided start/duration data.

Stop subscriptions and animation registrations on completion, removal, session navigation, reload, and shutdown. Print and HTML rendering never register animation or live subscriptions.

Distinguish tool-call completion from background activity. A completed `sh` launch can have a successful root and a running process child. Only a live runtime subscription can update that process child after the tool returns. A replayed result displays the recorded background state and timestamp without claiming current activity. Apply the same distinction to scheduled alarms and LSP startup states.

## Content limits, safety, and export

Reuse the bounded object snapshot logic in [`object-tree-data.ts`](../../cpi-fork/packages/coding-agent/src/modes/interactive/components/object-tree-data.ts) as an adapter, not as the generic tree model. Preserve scalar types, escaped keys, accessor avoidance, reference notices, binary redaction, and control-sequence sanitation. Single-child path compaction must not erase an independently inspectable domain row; keep compaction optional for object-field presentation.

Keep three cases distinct: hidden retained content, a bounded rendering preview, and source data that the tool did not retain. Pagination can reveal retained children. A display limit reports the limit and any full-output reference. Missing or truncated rendering metadata reports unavailable detail; expansion must not imply recovery of data that was never retained. Do not enlarge cpi's nested-call retention budgets as a side effect of presentation unification.

Bound model traversal, rendered rows, bytes, depth, retained interaction state, and preview work. Traverse iteratively. Pagination/limit notices use normal selectable tree rows. Adapters materialize expensive bodies only when the selected visibility policy needs those bodies. A renderer failure produces a sanitized generic fallback and a diagnostic without changing tool execution or its model-facing result.

Images require one owner. A semantic attachment node owns image rendering and visibility; the tool host must not append the same image again. Image/custom content receives a real allocated rectangle. Do not wrap, truncate, or prefix terminal graphics protocol payloads as ordinary text. Keep the current image renderer specialized until this placement path works in actual terminals.

HTML exports render semantic nodes as nested native disclosure elements with status text, escaped content, and independent expansion. The export must not flatten a tree into two whole-tool ANSI snapshots. Semantic renderers take precedence over the current built-in-name template shortcut, including cpi overrides of `read`, `write`, and `edit`. Non-tree escape hatches may retain ANSI-to-HTML conversion. Export reconstructs presentation from stored results; no new session storage schema or persisted component objects are required.

## Implementation order

1. **Primitive and host interaction:** implement the forest layout, stable-ID state, input/hit regions, configurable inspection actions, host focus routing, and shared animation lifecycle. Export the primitive from TUI.
2. **Semantic tool contract:** add the single snapshot hook and core resolver path; implement the generic object/text adapter and semantic HTML export. Retain specialized hooks for unmigrated tools.
3. **First complete vertical migration:** migrate generic/MCP rendering and the small `alarm`, `set_cwd`, `wait_any`, signal/detach/list tools. Exercise direct calls, restored calls, and export through the real host before broader migration.
4. **Content adapters:** migrate LSP, read summaries, and write/edit/patch presentation. Preserve existing compact content, partial failures, image behavior, and pre-execution edit previews.
5. **Nested execution and grouping:** migrate core/cpi code mode to the shared resolver and stable child identities, then replace cpi read/write grouping and duplicate layout wrappers. Retain bounded preview capture as data preparation. Update the subagent display consumer.
6. **Examples and cleanup:** update the example families above. Remove superseded layout implementations only after their production callers have migrated and any intentional functionality removal has been approved.

The required first milestone is a real tree-host integration, not a string-formatting helper. Later reuse by the activity panel or session selector is optional.

## Verification plan

Extend existing integration coverage instead of adding one formatting test per tool. Existing starting points include the fork's `test/object-tree.test.ts` and cpi's `scripts/tool-tree.integration.mjs`, `scripts/object-tree.integration.mjs`, and `scripts/codemode-render.integration.mjs`.

Verify observable contracts:

- Two roots and two sibling children toggle independently. Collapse/reopen, streaming completion, component updates, theme changes, and resize preserve node identity and local state.
- Direct and nested invocations resolve the same adapter, including an explicitly customized MCP tool and a resumed MCP tool before reconnection.
- Keyboard-only inspection works in regular and fullscreen modes. Leaving inspection restores typing and application shortcuts. Clicking a wrapped control toggles only that node; links, drag selection, and wheel scrolling still work.
- Narrow widths, deep nesting, wide/combining characters, ANSI styles, and metadata wrapping remain within the allocated width. Visual body placement and hit regions remain aligned after resize.
- A partial-application failure retains applied hunks and the failure reason. Successful compact shell output stays compact. Expansion of incomplete nested metadata shows an unavailable-detail notice rather than invented output.
- Real image and custom-body rendering neither duplicates attachments nor corrupts terminal graphics. HTML supports independent disclosure and escapes hostile data.
- Running trees share the animation scheduler. Completion, reload, navigation, and shutdown leave no active tree timers or stale subscriptions. Inspecting older transcript content preserves the scroll anchor.

Use the repository's faux/local provider and terminal harness for runtime verification; do not call paid providers. Run focused changed tests and the fork's `npm run check` after code implementation. This design-only change does not require runtime checks.

## References

- [Pi TUI component, input, mouse, and rendering contracts](../../cpi-fork/packages/coding-agent/docs/tui.md)
- [Extension tool rendering and resolver contract](../../cpi-fork/packages/coding-agent/docs/extensions.md#tool-rendering)
- [Configurable application actions](../../cpi-fork/packages/coding-agent/docs/keybindings.md)
- [Upstream TUI source](https://github.com/earendil-works/pi/tree/main/packages/tui/src)
