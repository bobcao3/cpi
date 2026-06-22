# Feature comparison: Kanban — Linear boards versus Basecamp Card Tables

Research date: 2026-06-23
Researcher: pi agent

## Scope and method

This is a narrow, feature-focused comparison of how each product does a kanban
board. It is descriptive: it states what each does and how they differ, with no
recommendation. All Linear quotations are verbatim from the canonical
`linear.app/docs/*` articles, read in full on 2026-06-23 with a headless
Chromium browser (Chromium 149 via Playwright). Basecamp quotations are verbatim
from the [Basecamp features page](https://basecamp.com/features). The broader
Linear-versus-Basecamp framing lives in `PriorArt.md`; this document goes deep on
one feature.

## Linear: the board is a layout, a projection of the typed graph

In Linear, "board" is not a kind of object — it is a *layout* applied to a view.
"Nearly all views in Linear can be shown in board layout in addition to list
view," and "you can toggle on board layout with the keyboard shortcut Cmd/Ctrl B"
([docs: Board layout](https://linear.app/docs/board-layout)). Because it is a
layout, it inherits the rest of the product: "Functionality and keyboard
shortcuts are almost exactly the same on board and list views."

Columns are not hand-built; they are *derived* from a grouping property.
"Display options let you group and order issues and projects," and you can
"Group issues by properties such as status, assignee, project, priority, cycle,
label, parent issue, team, customer, release, and SLA status"
([docs: Display options](https://linear.app/docs/display-options)). A second
level is available — "Sub-grouping is available in lists and boards (as rows),"
i.e. swimlanes — and each group shows a live count: "Beside each group in board
or list view, you will see either the total number of issues in the group or the
total estimate of all issues in the group."

The decisive property of this design is that a card is a real issue, so moving
it mutates state: "You can drag and drop issues between each grouping and it will
automatically adopt the properties of that grouping." Group the board by status
and it *becomes* the team's typed workflow state machine — "These workflows are
team-specific and come with a default set and order: Backlog > Todo > In Progress
> Done > Canceled"
([docs: Issue status](https://linear.app/docs/configuring-workflows)) — and the
docs even recommend the board for that ordering: "If you prefer to order issues
by status in your team's workflow order, use board views instead"
([docs: Display options](https://linear.app/docs/display-options)). Within a
column, "Option/Alt Shift Up or Down to move a selected issue to the top or
bottom of the column," and "T to toggle the collapse or expansion of a swimlane"
([docs: Board layout](https://linear.app/docs/board-layout)).

A configured board is itself a first-class, shareable object. "Create durable
filtered views of issues, projects, or initiatives that you can save and share
with others in your workspace," and "you can also save any filtered board or
list as a custom view with the keyboard shortcut Option/Alt V"
([docs: Custom Views](https://linear.app/docs/custom-views)). Display options
"can be saved as personal preferences or as the default display options on that
page for your workspace"
([docs: Display options](https://linear.app/docs/display-options)), so one
canonical board can be shared across a team.

## Basecamp: the Card Table is a widget, an artifact attached to a project

In Basecamp the kanban is a *tool* you add to a project page. "In Basecamp, every
project you create gets a dedicated page. From there you can customize the page
with built-in tools (to-dos, message boards, chat rooms, a calendar, kanban card
tables, etc)" ([features](https://basecamp.com/features)). The tool itself is
described in one paragraph:

> Card Tables are our take on kanban boards. It's a wonderfully visual way to
> track work through a process. Add cards, set up columns, move work through
> phases. Specify who should be notified when a new card is added to the table,
> or to a specific column. It's perfect for bug and issue tracking, software
> development, production work, or anything that goes through distinct phases.

Columns here are set up by hand as "phases," not derived from a status field, and
a card is a card — it has no typed properties, no identifier, no relations; it is
an artifact on a board, not an issue in a graph. The board's behavior beyond
movement is notification routing: who gets told when a card lands in a column.

## How they differ

| Dimension | Linear | Basecamp |
|---|---|---|
| What a board is | A *layout* on any view of issues, projects, or initiatives | A *tool/widget* attached to one project page |
| Where columns come from | *Derived* from a grouping property (status, assignee, priority, cycle, label, team, customer, release, SLA, …) | *Set up by hand* as named phases |
| What a card is | A typed issue with an ID, status, relations, estimates | A standalone card with no underlying typed record |
| Moving a card | *Mutates state* — the issue adopts the column's property (e.g. its status) | *Repositions an artifact* — no field changes |
| Beyond columns | Sub-grouping as swimlanes; per-column count or total estimate | Per-column and per-table notification routing |
| Persistence | Saved as a shareable Custom View; can be the workspace default | Lives on the project page it was added to |
| Keyboard parity with the rest of the app | Full — board and list share shortcuts | N/A — the Card Table is its own surface |

The core difference is one of data model. Linear's board is a *projection* of a
typed graph: the columns are a view of a property, and dragging a card writes
back to the issue, so the same work is consistent across every board, list, and
graph that reads it. Basecamp's Card Table is an *artifact*: the board is the
thing itself, columns are free-form phases, and a card carries no state that any
other view would read. Group Linear's board by status and it becomes the workflow
state machine; Basecamp's columns are whatever the team names, decoupled from any
status enum. The trade-off is fidelity and consistency on Linear's side against
simplicity and locality on Basecamp's: a Linear board can never drift from the
issue's real state, while a Basecamp Card Table can be set up in seconds for any
process that "goes through distinct phases" without modeling it first.

## Sources

All verified 2026-06-23. Linear articles read in full with headless Chromium 149
via Playwright.

- [Linear docs: Board layout](https://linear.app/docs/board-layout)
- [Linear docs: Display options](https://linear.app/docs/display-options)
- [Linear docs: Custom Views](https://linear.app/docs/custom-views)
- [Linear docs: Issue status (configuring workflows)](https://linear.app/docs/configuring-workflows)
- [Basecamp features](https://basecamp.com/features) — Card Tables, the project page
