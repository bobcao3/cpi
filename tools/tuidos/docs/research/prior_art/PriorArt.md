# Prior Art: Linear versus Basecamp (a sourced comparison)

Research date: 2026-06-23
Researcher: pi agent

## Purpose

This document compares Linear and Basecamp as two opposing reference
philosophies for managing work. For each design dimension it describes Linear's
approach and the situations that approach suits, then Basecamp's approach and
the situations that approach suits, and finally the way the two differ. Every
Linear claim is grounded in a first-hand article from Linear's own docs, read
in full on 2026-06-23 with a headless Chromium browser (system Chromium 149
driven by Playwright) against the canonical `linear.app/docs/*` URLs; every
Basecamp claim is grounded in the *Shape Up* book or the Basecamp features site.
The comparison is descriptive throughout: it offers no recommendations and
expresses no opinion about what tuidos should do.

### tuidos context, stated factually

tuidos is a local, SQLite-backed terminal tool. According to its `DESIGN.md`,
its current state consists of a named project registry in which projects are
"named entries, not tied to folders"; a per-project SQLite database that holds
"Tasks, kanban columns, and metadata"; and two clients — a non-TTY CLI called
`clidos` and an interactive TUI called `tuidos` — that read and write the same
SQLite files over a WAL-enabled database with "no global coordination server."
`DESIGN.md` is silent on the semantics of kanban columns, on task hierarchy,
and on the progress model. This is mentioned only as factual context, and the
comparison that follows draws no conclusion about tuidos.

### A note on sources

Both vendors' first-hand material is now read directly. Basecamp publishes the
entire *Shape Up* book online and free, so its first-hand material is unusually
rich. Linear's docs are a JavaScript single-page application, but its canonical
article URLs live on `linear.app/docs/*` (not `docs.linear.app/features/*`,
which renders only the docs index); those articles were each loaded in a real
headless browser and read in full. Every Linear quotation below is verbatim from
one of those articles. An earlier draft of this document marked some sub-details
`*(orig.)*` as inherited and unverified; all of those have since been checked
first-hand and are folded in below, corrected where the source differed.

Other terminal and local-first tools — Taskwarrior with vit, dstask, todo.txt,
taskell, and the 2025–2026 wave of SQLite-backed TUI tools (Kairo, RustKanban,
cli_kanban, fulsomenko/kanban, tasc, kaban, and TaskYou) — form the real
competitive set for tuidos, but they belong in a separate document and are
named here only for context.

## Linear: an issue-centric execution system

Linear models work as a typed graph that is meant to auto-advance and to be
measured. Its hierarchy runs from the Workspace down through Teams to Issues,
Projects, and Initiatives. The team is the primary organizing unit: "Create
teams in your workspace to organize different types of work functions"
([docs: Teams](https://linear.app/docs/teams)), and a team carries its own
issues, its issue-status workflow, its cycles, its triage inbox, and its
projects — each appears as a child of the team in the docs' own sidebar
([docs: Teams](https://linear.app/docs/teams)). An issue is an atomic, typed
work item: "Issues are always linked to a single team. They have an issue ID
(the team's issue identifier and unique number) and are required to have a title
and a status — all other properties and relations are optional"
([docs: Create issues](https://linear.app/docs/creating-issues)). Its
identifier looks like `ENG-123` and is scoped to the team — the GitHub docs show
the magic-word form "Fixes ENG-123" ([docs: GitHub](https://linear.app/docs/github)),
and moving an issue to another team "generates a new issue ID" while the old one
stays searchable ([docs: Edit issues](https://linear.app/docs/editing-issues)).

A workflow is a per-team, ordered state machine rather than a single global
enum: "Issues statuses define the type and order of states that issues can move
through from start to completion. These workflows are team-specific and come with
a default set and order: Backlog > Todo > In Progress > Done > Canceled,"
and "Statuses can be rearranged within a category but categories cannot be moved
around" ([docs: Issue status](https://linear.app/docs/configuring-workflows)).
Issue relations "indicate blocked, blocking, related, and duplicate issues" —
"You can mark issues as blocked, blocking, related, and duplicate"
([docs: Issue relations](https://linear.app/docs/issue-relations)). Larger tasks
decompose through parent and sub-issues, and Linear turns authored text into
tracked items: "If you have a list (bulleted, numbered or checklist) you can
highlight the checklist and hit Cmd/Ctrl Shift O to convert to sub-issues," and
"a comment under an issue" can be turned into a sub-issue
([docs: Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)).
Projects are "units of work that have a clear outcome or planned completion
date... and are comprised of issues and optional documents... shared across
multiple teams" ([docs: Projects](https://linear.app/docs/projects)), and
initiatives "group projects by company objective to align on your organization's
goals and track progress towards achieving them"
([docs: Initiatives](https://linear.app/docs/initiatives)). The Linear Method
frames direction as a set of practices — "Set the product direction," "Set
useful goals," "Prioritize enablers and blockers," and "Scope projects down,"
plus the building practices "Generate momentum" and "Write issues not user
stories" ([Linear Method](https://linear.app/method)).

### Linear's GitHub status automation, in the vendor's words

The pattern that matters most for this comparison is the way Linear's status
advances automatically from code. The [GitHub integration docs](https://linear.app/docs/github)
state it directly. "Linear supports linking your GitHub pull requests,
automating workflow statuses, and syncing issues between GitHub and Linear."
The status is driven by a magic word plus the issue ID: "Use a magic word + issue
ID in the PR description or title (e.g. Fixes ENG-123...)." The behavior is
explicit: "When using a closing magic word, Linear will move the issue to In
Progress when the branch is pushed and Done when the commit is merged to the
default branch." The closing magic words are listed verbatim — "close, closes,
closed, closing, fix, fixes, fixed, fixing, resolve, resolves, resolved,
resolving, complete, completes, completed, completing, implement, implements,
implemented, implementing, linear issue" — alongside non-closing words ("ref,
refs, references, part of, related to, relates to, contributes to, toward,
towards") that "will still move the issue through other statuses per Workflow
settings, but will not automate the issue's status when the PR or commit merges."
An issue is linked through its identifier in the branch name, the pull-request
title, or the PR description, and the integration is two-way: comments and
checks sync between GitHub and Linear. The integration is event-driven rather
than poll-driven, so updates land within seconds of a merge.

## Basecamp: a conversation-centric collaboration system

Basecamp takes the project page as its root unit and attaches tools to it as
widgets, following the Shape Up and REWORK philosophy. The
[features page](https://basecamp.com/features) describes the project page as a
dedicated page for every project that you customize "with built-in tools
(to-dos, message boards, chat rooms, a calendar, kanban card tables, etc)."
Message Boards are meant to "essentially replace email" and to act as "a shared
inbox for the project." To-do Lists let you "make a list, or ten lists," assign
items, set due dates, create subtasks, and drag items between lists. Card
Tables are Basecamp's take on kanban: you "add cards, set up columns, move work
through phases," and you can specify who is notified when a card is added.
Campfire provides per-project group chat, the Schedule offers a project
calendar plus a global aggregating calendar with iCal support, and Automatic
Check-ins "cut back on meetings and stand ups" by asking questions on a
schedule and saving the answers to a single log. Hill Charts show qualitative
progress ([Hill Charts page](https://basecamp.com/hill-charts),
[Shape Up ch.13](https://basecamp.com/shapeup/3.4-chapter-13)). The Reports
view offers a Lineup timeline, a Mission Control status grid, a Hilltop view of
every Hill Chart, and lists of added, completed, overdue, unassigned, and
time-sheeted work. The personal "My Bar" aggregates your tasks, events, and
bookmarks and is keyboard accessible.

### Basecamp's Shape Up, in the book's words

The [Shape Up](https://basecamp.com/shapeup) book supplies the load-bearing
organizational ideas. Basecamp runs in "six-week cycles" with a "cool-down"
after each, settled on after years of experimentation
([ch.8](https://basecamp.com/shapeup/2.2-chapter-08)). It replaces the backlog
with a betting table: "there's no giant list of ideas to review... no time spent
grooming a backlog... just a few well-shaped, risk-reduced options," and the
lists that do exist are decentralized, so that "none of these lists are direct
inputs to the betting process"
([ch.7](https://basecamp.com/shapeup/2.1-chapter-07)). Each cycle starts from
"a clean slate... one cycle at a time... never carrying scraps of old work over
without first shaping and considering them"
([ch.8](https://basecamp.com/shapeup/2.2-chapter-08)). Two explicit design
goals are uninterrupted time for makers and a "circuit breaker" that stops
projects which will not finish in-cycle
([ch.8](https://basecamp.com/shapeup/2.2-chapter-08)). Progress is represented
as a hill: every piece of work has "an uphill phase of figuring out... a
downhill phase of execution," and the method lets you "see the status of the
project without counting tasks and without numerical estimates," shifting
attention to "what's unknown and what's solved"
([ch.13](https://basecamp.com/shapeup/3.4-chapter-13)). The team "intuitively
drag the scopes into position, and save a new update that's logged on the
project," so that managers get context "without peppering the team with
questions" ([Hill Charts page](https://basecamp.com/hill-charts)). The
sequencing rule is to "push the scariest work uphill first" and to leave the
"screw-tightening for later"
([ch.13](https://basecamp.com/shapeup/3.4-chapter-13)).

## Design-pattern comparison

For each of the ten dimensions below, the description covers Linear's approach
and what it suits, then Basecamp's approach and what it suits, and finally the
way the two differ.

**1. Root organizing unit.** Linear organizes work around the team, and each
team owns its issues, its issue-status workflow, its cycles, its triage inbox,
and its projects ([docs: Teams](https://linear.app/docs/teams)); this suits
organizations in which work is owned by a function and each function runs its
own process. Basecamp organizes work around the project page, to which tools
attach ([features](https://basecamp.com/features)); this suits work that is
grouped by deliverable rather than by owning function, with the process chosen
per project. The difference is that Linear roots ownership in the team while
Basecamp roots containment in the project.

**2. Status model.** Linear uses a typed, per-team, ordered state machine that
auto-advances from pull-request and commit events — "These workflows are
team-specific," defaulting to "Backlog > Todo > In Progress > Done > Canceled,"
and "Linear will move the issue to In Progress when the branch is pushed and
Done when the commit is merged"
([docs: Issue status](https://linear.app/docs/configuring-workflows),
[docs: GitHub](https://linear.app/docs/github)); this suits engineering teams
whose task status should track code state automatically. Basecamp makes the
card's column its status — you "add cards, set up columns, move work through
phases" ([features](https://basecamp.com/features)) — which suits teams that
want status without a separate field or any automation. The difference is
between an explicit, typed, event-driven state machine and an implicit status
defined by placement.

**3. Hierarchy depth.** Linear uses a deep, typed graph with sub-issues,
parent issues, and blocked, blocking, related, and duplicate relations — "You
can mark issues as blocked, blocking, related, and duplicate"
([docs: Issue relations](https://linear.app/docs/issue-relations),
[docs: Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues));
this suits work that decomposes and depends on other work. Basecamp is
deliberately flat, moving from project to item with no edges
([features](https://basecamp.com/features)); this suits work that does not need
dependency tracking. The difference is between a relational graph and a flat
list.

**4. Time and cadence.** Linear uses recurring cycles and project milestones:
cycles are "time-boxed periods where a team works on completing a pre-defined
set of work... Unlike sprints, cycles are not tied to releases," last one to
eight weeks, and include "a cooldown period after each cycle to give your team a
break" ([docs: Cycles](https://linear.app/docs/use-cycles)); milestones
"represent different stages in a project's lifecycle" and are "visible from
Initiatives and project views on a timeline"
([docs: Project milestones](https://linear.app/docs/project-milestones)); this
suits teams that plan in iterations and measure throughput. Basecamp uses
six-week cycles with a betting table, a cool-down, a clean slate, and a circuit
breaker ([ch.7](https://basecamp.com/shapeup/2.1-chapter-07),
[ch.8](https://basecamp.com/shapeup/2.2-chapter-08)); this suits teams that
scope fixed windows and judge scope rather than count velocity. The difference
is between counting velocity per iteration and betting on a fixed box with a
clean slate — though both deliberately include a cooldown, a shared idea.

**5. Progress representation.** Linear is quantitative, computing progress from
issue data through Insights — "Insights turns your Linear issues into a dataset
you can analyze," asking "How quickly do you fix bugs? Do you estimate
accurately?" ([docs: Insights](https://linear.app/docs/insights)); this suits
data-driven review. Basecamp is qualitative, using Hill Charts that show uphill
and downhill position "without counting tasks and without numerical estimates"
([ch.13](https://basecamp.com/shapeup/3.4-chapter-13),
[Hill Charts page](https://basecamp.com/hill-charts)); this suits surfacing
what is still unknown against what is already solved. The difference is between
progress derived from data and progress expressed through human judgment of a
hill position.

**6. Capture versus commitment.** Linear separates captured from committed
work with a triage inbox — "Triage is an additional status category that acts
as an Inbox for your team... particularly powerful when combined with other
integrations like Asks, Slack, or our support ticketing integrations"
([docs: Issue status](https://linear.app/docs/configuring-workflows),
[docs: Triage](https://linear.app/docs/triage)) — and treats scoping as a
practice ([Linear Method](https://linear.app/method)); this suits funnelling
many inputs from integrations and other teams before commitment. Basecamp
refuses a backlog altogether — "bets, not backlogs," with decentralized lists
and ideas that re-surface ([ch.7](https://basecamp.com/shapeup/2.1-chapter-07))
— which suits avoiding the overhead of grooming. The difference is between an
explicit triage state and the removal of a central backlog.

**7. Where conversation lives.** Linear anchors conversation to the work:
"Comments and reactions allow for team collaboration within an issue. All users
with access to an issue can post comments and threaded replies"
([docs: Comments and reactions](https://linear.app/docs/comment-on-issues));
this suits keeping discussion attached to a specific work item. Basecamp makes
conversation a first-class tool, through Message Boards and Campfire, loosely
tied to tasks ([features](https://basecamp.com/features)); this suits
project-wide discussion that is independent of any task. The difference is that
conversation follows the task in Linear and stands as a peer of tasks in
Basecamp.

**8. Interruption model.** Linear is real-time and fast — "You'll always see
notifications in your Linear inbox. For real-time alerts, you can use the Linear
desktop app, mobile app, Slack, or email digests," across Desktop, Mobile,
Email, and Slack channels ([docs: Notifications](https://linear.app/docs/notifications));
this suits high-velocity, roughly synchronous teams. Basecamp is calm by
design, with uninterrupted time, a circuit breaker, and asynchronous rituals
([ch.8](https://basecamp.com/shapeup/2.2-chapter-08),
[features](https://basecamp.com/features)); this suits async, meeting-light
collaboration. The difference is between optimizing for real-time flow and
optimizing for calm, asynchronous work.

**9. Integration depth.** Linear is deep and code-native: status advances from
pull-request and commit state, and comments and checks sync both ways — "Linear
supports linking your GitHub pull requests, automating workflow statuses, and
syncing issues between GitHub and Linear" ([docs: GitHub](https://linear.app/docs/github));
this suits engineering workflows in which code state should drive task state.
Basecamp is shallow and link-based, keeping cloud files linked rather than
synced ([features](https://basecamp.com/features)); this suits light external
linking without state coupling. The difference is that integrations drive state
in Linear and act as links in Basecamp.

**10. Authoring into tracking.** Linear turns authoring into tracking through
conversion semantics: "If you have a list (bulleted, numbered or checklist) you
can highlight the checklist and hit Cmd/Ctrl Shift O to convert to sub-issues,"
a comment can be turned into a sub-issue, and an issue can be converted into a
project ([docs: Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues));
issues also carry "documents... to create specs"
([docs: Issue documents](https://linear.app/docs/issue-documents)); this suits
turning written specs into tracked work. Basecamp treats documents as filing, as
storage that is not a source of tracked items
([features](https://basecamp.com/features)); this suits reference material kept
separate from tasks. The difference is that authoring produces tracked items in
Linear and produces files in Basecamp.

## Sources

These are vendor first-hand documents and guides, all verified on 2026-06-23.
Linear's docs articles were read in full with a headless Chromium browser
(Chromium 149 via Playwright) at their canonical `linear.app/docs/*` URLs.

- [Linear features](https://linear.app/features)
- [Linear Method](https://linear.app/method) — Set product direction; Set useful
  goals; Prioritize enablers and blockers; Scope projects down; Generate
  momentum; Write issues not user stories
- [Linear docs: Teams](https://linear.app/docs/teams)
- [Linear docs: Create issues](https://linear.app/docs/creating-issues)
- [Linear docs: Edit issues](https://linear.app/docs/editing-issues)
- [Linear docs: Issue status (configuring workflows)](https://linear.app/docs/configuring-workflows)
- [Linear docs: Issue relations](https://linear.app/docs/issue-relations)
- [Linear docs: Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)
- [Linear docs: Issue documents](https://linear.app/docs/issue-documents)
- [Linear docs: Comments and reactions](https://linear.app/docs/comment-on-issues)
- [Linear docs: Projects](https://linear.app/docs/projects)
- [Linear docs: Project milestones](https://linear.app/docs/project-milestones)
- [Linear docs: Initiatives](https://linear.app/docs/initiatives)
- [Linear docs: Cycles](https://linear.app/docs/use-cycles)
- [Linear docs: Triage](https://linear.app/docs/triage)
- [Linear docs: Notifications](https://linear.app/docs/notifications)
- [Linear docs: Insights](https://linear.app/docs/insights)
- [Linear docs: GitHub integration](https://linear.app/docs/github) — PR/commit
  status automations, magic words (closing and non-closing), branch-name
  formatting, commit linking, two-way issue sync
- [Basecamp features](https://basecamp.com/features)
- [Basecamp Hill Charts](https://basecamp.com/hill-charts)
- [Shape Up ch.7: Bets, Not Backlogs](https://basecamp.com/shapeup/2.1-chapter-07)
- [Shape Up ch.8: The Betting Table](https://basecamp.com/shapeup/2.2-chapter-08)
- [Shape Up ch.9: Place Your Bets](https://basecamp.com/shapeup/2.3-chapter-09)
- [Shape Up ch.13: Show Progress](https://basecamp.com/shapeup/3.4-chapter-13)
- `DESIGN.md` (this repo) — the sole source for tuidos's own grounded state
