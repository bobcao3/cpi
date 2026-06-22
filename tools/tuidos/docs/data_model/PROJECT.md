# Per-project state — `state.sqlite`

Stored at `~/.local/state/tuidos/projects/<project-id>/state.sqlite`, one file
per project. Holds that project's kanban columns, tasks, and the many-to-many
link between tasks and global topics.

Universal invariants apply (see `DESIGN.md` -> Schema -> Universal invariants);
notably rule 1: every timestamp is UTC unix milliseconds.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Bookkeeping: schema version, defaults. Grows by key only.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- CORE: kanban columns = this project's statuses. A task has exactly one
-- column (its status); column membership is the board's primary axis.
-- Core holds identity only; column order is presentation, below.
CREATE TABLE columns (
  id          TEXT    PRIMARY KEY,                            -- id
  name        TEXT    NOT NULL UNIQUE
                      CHECK (length(name) BETWEEN 1 AND 64),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- CORE: tasks. Holds identity, status, and semantic fields only;
-- on-board ordering is presentation (task_display), not core.
CREATE TABLE tasks (
  id            TEXT    PRIMARY KEY,                          -- id
  title         TEXT    NOT NULL
                        CHECK (length(title) BETWEEN 1 AND 256),
  description   TEXT,
  column_id     TEXT    NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,  -- status
  priority      INTEGER CHECK (priority BETWEEN 0 AND 4),     -- 0 none .. 4 urgent
  assignee      TEXT,
  estimate      INTEGER CHECK (estimate IS NULL OR estimate >= 0),
  due_at        INTEGER,                                      -- UTC unix ms
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  archived_at   INTEGER
);
CREATE INDEX tasks_column ON tasks(column_id);

-- CORE: many-to-many — a task may belong to several topics (aspects) at once.
-- topic_id references global.topics(id) across DB files — no FK; safe because
-- global topics are never hard-deleted (see GLOBAL.md).
CREATE TABLE task_topics (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL,                                   -- -> global.topics(id)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, topic_id)
);
CREATE INDEX task_topics_topic ON task_topics(topic_id);

-- PRESENTATION (non-core, persisted + shared): on-board ordering for display.
-- Separated from core so the essential model stays free of UI concerns.
CREATE TABLE column_display (
  column_id TEXT PRIMARY KEY REFERENCES columns(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0                       -- column order
);
CREATE TABLE task_display (
  task_id  TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0                        -- order within the column
);

-- CORE: append-only audit trail for THIS project's task/column changes. The
-- same table exists in the global DB (GLOBAL.md) for project/topic lifecycle;
-- `clidos audit` (or `clidos project audit <project>`) merges them by `ts`.
CREATE TABLE audit_log (
  id           TEXT    PRIMARY KEY,                          -- random id
  ts           INTEGER NOT NULL,                             -- UTC unix ms (event time)
  project_id   TEXT,                                         -- this project's id
  action       TEXT    NOT NULL
                       CHECK (length(action) BETWEEN 1 AND 64),
  entity_type  TEXT    NOT NULL
                       CHECK (length(entity_type) BETWEEN 1 AND 32),
  entity_id    TEXT,                                         -- affected id; NULL when none
  summary      TEXT    NOT NULL
                       CHECK (length(summary) BETWEEN 1 AND 512)
);
CREATE INDEX audit_log_ts ON audit_log(ts DESC);
CREATE INDEX audit_log_project ON audit_log(project_id);
```

## Invariants

- **Core vs presentation.** Core (`columns`, `tasks`, `task_topics`) holds
  identity, status, and relationships only. On-board ordering —
  `column_display.position` and `task_display.position` — is presentation:
  persisted and shared, but non-core, each a 1:1 row with a real FK +
  `ON DELETE CASCADE`. Board rendering is deferred (see `DESIGN.md`); these
  tables only store the prefs.
- **A task has exactly one column** (`column_id NOT NULL`, `ON DELETE RESTRICT`)
  and **zero or more topics**. A project is initialized with at least one
  column (e.g. Backlog, In Progress, Done) so a status always exists; to delete
  a column, move its tasks first.
- **"Unassigned" is the implicit topic.** A task with no `task_topics` rows is
  unassigned; the client renders such tasks under a virtual "Unassigned" group
  when grouping by topic. There is no `#random` or default-topic row anywhere —
  topics are always explicit, user-created rows in `GLOBAL.md`.
- `task_topics.task_id` is a real FK with `ON DELETE CASCADE`: deleting a task
  drops its associations. `task_topics.topic_id` is a cross-DB reference to
  `global.topics(id)` — not a FK; it stays valid because global topics are never
  hard-deleted.
- When grouping by topic, sort by `priority` / `created_at`; per-topic manual
  drag-order is not stored in v1 (add a `position` column to a topic-scoped view
  only if later required).
- Identifiers are 160-bit random ids (`TEXT`, 32-char Crockford base32).
- **Audit trail is append-only.** This file's `audit_log` records task and column
  changes for this project; project/topic lifecycle is audited in GLOBAL.md.
  Rows are inserted in the same transaction as the change, never updated or
  deleted. `clidos audit` (and `clidos project audit <project>`) merges all
  files by `ts` (UTC unix ms).
