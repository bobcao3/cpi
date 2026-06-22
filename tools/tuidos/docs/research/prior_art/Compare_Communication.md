# Feature comparison: communicating ticket and project status — Linear versus Basecamp

Research date: 2026-06-23
Researcher: pi agent

## Scope and method

This is a narrow, feature-focused comparison of the mechanisms each product
gives a team to *communicate status* — where a ticket or project stands, and how
that standing reaches the people who need it. It is descriptive, with no
recommendation. All Linear quotations are verbatim from the canonical
`linear.app/docs/*` articles, read in full on 2026-06-23 with a headless
Chromium browser (Chromium 149 via Playwright). Basecamp quotations are verbatim
from the [Basecamp features page](https://basecamp.com/features) and the
[Shape Up](https://basecamp.com/shapeup) book. The broader framing lives in
`PriorArt.md`.

## Linear: status as computed data, structured updates, and routed events

Linear communicates status at three levels, and much of it is derived from issue
state rather than written by hand.

**At the ticket level**, status is the issue's typed field, and its position on
a board *is* that status — grouped by status, the board becomes the team's
per-team workflow ("Backlog > Todo > In Progress > Done > Canceled,"
[docs: Issue status](https://linear.app/docs/configuring-workflows)). Changes
fan out as events: "You'll always see notifications in your Linear inbox. For
real-time alerts, you can use the Linear desktop app, mobile app, Slack, or
email digests," across Desktop, Mobile, Email, and Slack channels
([docs: Notifications](https://linear.app/docs/notifications)). Discussion is
attached to the ticket: "Comments and reactions allow for team collaboration
within an issue. All users with access to an issue can post comments and
threaded replies" ([docs: Comments and reactions](https://linear.app/docs/comment-on-issues)).

**At the project level**, there is a deliberate split between a manual human
signal and auto-computed graphs. The human signal is a typed status field:
"Project statuses clarify where each project is in its lifecycle... A project
status offers a quick update for stakeholders," with categories Backlog,
Planned, In Progress, Completed, and Canceled — and it is explicitly manual:
"Project statuses are updated manually — we do not do this automatically, even if
all issues are completed"
([docs: Project status](https://linear.app/docs/project-status)). Alongside it
sits a structured written update: "Initiative and Project updates are structured
reports that keep teams and leaders informed on progress and alignment. They
consist of a health indicator that provides high-level signal of the current
state and a rich text description," and they "can be viewed in Linear and sent
to Slack channels" with configurable weekly/biweekly reminders
([docs: Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)).

The graphs, by contrast, compute themselves. "The graph shows you the progress
you're making toward completing your project and estimates when you'll complete
it... autogenerate once the status of a project has been moved to a Started
status... statistics update hourly... Predictions are calculated based on weekly
velocity data" ([docs: Project graph](https://linear.app/docs/project-graph)).
Cycles get a burndown: "The gray line displays the total scope of your cycle,"
the dotted line is an even "target" distribution that "flattens over weekends,"
and further lines track issues started and completed
([docs: Cycle graph](https://linear.app/docs/cycle-graph)). At workspace scale,
"Insights turns your Linear issues into a dataset you can analyze"
([docs: Insights](https://linear.app/docs/insights)) and Dashboards "bring
together insights from across teams and projects onto a single page"
([docs: Dashboards](https://linear.app/docs/dashboards)).

**Routing** is per-project and programmable. "Click on the bell icon on any
project page to subscribe to that project's notifications," and a project can
post to its own Slack channel — "a great way to keep other team members in the
loop," where "Linear members will be able to take actions on the issue directly
from Slack" ([docs: Project notifications](https://linear.app/docs/project-notifications)).
Status also arrives from outside the product: GitHub PR and commit state drive
issue status, and comments and checks sync both ways
([docs: GitHub](https://linear.app/docs/github)). Inbound requests enter the
same pipeline through Linear Asks, which "turns requests like bug reports,
questions, and IT needs into actionable issues" submitted via Slack, email, or
web forms ([docs: Linear Asks](https://linear.app/docs/linear-asks)).

## Basecamp: status as human judgment, scheduled ritual, and overview reports

Basecamp communicates status almost entirely through human judgment and
conversation; nothing is computed from a dataset.

**The signature status signal is the Hill Chart**, a qualitative shape rather
than a number. "Hill Charts show you where things really stand," and per *Shape
Up* the method lets you "see the status of the project without counting tasks
and without numerical estimates," with "an uphill phase of figuring out" and "a
downhill phase of execution"
([features](https://basecamp.com/features),
[ch.13](https://basecamp.com/shapeup/3.4-chapter-13)). The team "intuitively
drag the scopes into position, and save a new update that's logged on the
project" ([Hill Charts](https://basecamp.com/hill-charts)) — status is a dragged
position on a hill, written by a person.

**Status is also a scheduled ritual.** "Cut back on meetings and stand ups by
setting up Automatic Check-ins instead. Set up questions that are asked on a
regular schedule. Everyone's answers are saved back to a single log for easy
review," for example "What are you working on this week?" every Monday at 9am
([features](https://basecamp.com/features)). Where Linear pushes computed
updates, Basecamp asks people to write them on a cadence.

**Conversation carries the rest.** Message Boards "essentially replace email...
a shared inbox for the project... All project announcements, discussions,
presentations, etc, live on the message board," and Campfire provides
"real-time conversations, quick file sharing"
([features](https://basecamp.com/features)). **Overview reports** aggregate
status for leaders: "Mission Control shows you every project's status in one
view," "The Hilltop shows you every project's Hill Chart on a single screen,"
and the Lineup plots projects on a timeline, alongside Added/Completed,
Overdue, and Unassigned lists
([features](https://basecamp.com/features)). At the item level, notification
routing is configured per surface: "Specify who should be notified when a new
card is added to the table, or to a specific column," and "Set up who gets
notified when a to-do is completed" ([features](https://basecamp.com/features)).

## How they differ

| Dimension | Linear | Basecamp |
|---|---|---|
| Project status signal | A typed status field, set manually; plus structured written updates with a health indicator | A Hill Chart position, dragged manually |
| Quantitative progress | Auto-computed: project graph (velocity-based completion prediction), cycle graph (burndown), Insights, Dashboards | None — "without counting tasks and without numerical estimates" |
| Cadence mechanism | Configurable reminders to post updates (weekly/biweekly) | Automatic Check-ins ask a question on a schedule; answers logged |
| Where status lands | Inbox + Slack channels (per-project `#p-project-name`, workspace `#project-updates`); actions from Slack | Message Boards (shared inbox) + Campfire (chat) |
| Leadership overview | Dashboards and Insights across teams/projects | Mission Control grid, Hilltop all-hills, Lineup timeline |
| Ticket-level movement | Board column = issue status; moving a card mutates the typed field | Card/to-do position; per-column and per-to-do notification routing |
| External coupling | GitHub PR/commit state drives issue status both ways | Cloud files linked, not synced |

The core difference is what the status *is*. In Linear, status is a field on a
typed record, so it can be computed against (graphs, velocity predictions,
burndowns, dashboards) and pushed as events to the right Slack channel; the human
project-status note coexists with, and is distinct from, the auto-derived
graphs — and Linear is careful to keep the human note manual even when all
issues are done. In Basecamp, status is a person's judgment of where the work
sits on a hill, surfaced through a dragged position, a scheduled check-in
answer, or an overview report; nothing counts or predicts, by design. Linear
pushes quantitative signals derived from the work; Basecamp surfaces qualitative
judgment about the work. The trade-off is precision and automation on Linear's
side against simplicity and human legibility on Basecamp's: a Linear graph can
forecast a slip from velocity data, while a Basecamp Hill Chart can show that
work is "still uphill" in a way a number cannot — but neither product's manual
signal can substitute for the other's, which is why Linear keeps its typed
status manual and Basecamp keeps its hill qualitative.

## Sources

All verified 2026-06-23. Linear articles read in full with headless Chromium 149
via Playwright.

- [Linear docs: Notifications](https://linear.app/docs/notifications)
- [Linear docs: Comments and reactions](https://linear.app/docs/comment-on-issues)
- [Linear docs: Project status](https://linear.app/docs/project-status)
- [Linear docs: Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear docs: Project notifications](https://linear.app/docs/project-notifications)
- [Linear docs: Project graph](https://linear.app/docs/project-graph)
- [Linear docs: Cycle graph](https://linear.app/docs/cycle-graph)
- [Linear docs: Insights](https://linear.app/docs/insights)
- [Linear docs: Dashboards](https://linear.app/docs/dashboards)
- [Linear docs: Issue status (configuring workflows)](https://linear.app/docs/configuring-workflows)
- [Linear docs: GitHub integration](https://linear.app/docs/github)
- [Linear docs: Linear Asks](https://linear.app/docs/linear-asks)
- [Basecamp features](https://basecamp.com/features) — Hill Charts, Automatic
  Check-ins, Message Boards, Campfire, Reports, Card Tables
- [Basecamp Hill Charts](https://basecamp.com/hill-charts)
- [Shape Up ch.13: Show Progress](https://basecamp.com/shapeup/3.4-chapter-13)
