# Global state — `global.sqlite`

Stored at `~/.local/state/tuidos/global.sqlite`. Holds the project registry
and its topics — the complete project→topic tree, readable from one file. No
tasks live here; they are per-project (see `PROJECT.md`).

Universal invariants apply (see `DESIGN.md` → Schema → Universal invariants);
notably rule 1: every timestamp is UTC unix milliseconds.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Bookkeeping: schema version, defaults. Grows by key only.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- CORE: the project registry. Projects are named entries, not tied to
-- folders. A project's per-project DB path is derived: projects/<id>/state.sqlite.
CREATE TABLE projects (
  id           TEXT    PRIMARY KEY,                          -- id
  name         TEXT    NOT NULL UNIQUE
                       CHECK (length(name) BETWEEN 1 AND 128),
  description  TEXT,
  created_at   INTEGER NOT NULL,                              -- UTC unix ms
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,                                      -- soft-delete; NULL = active
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX projects_archived ON projects(archived_at);

-- CORE: aspects/workstreams of a project. A task may belong to several topics
-- (many-to-many; the association lives in PROJECT.md). Core holds identity and
-- lifecycle only — no color or ordering (those are presentation, below).
CREATE TABLE topics (
  id           TEXT    PRIMARY KEY,                           -- id
  project_id   TEXT    NOT NULL REFERENCES projects(id)
                      ON DELETE RESTRICT,
  name         TEXT    NOT NULL
                       CHECK (length(name) BETWEEN 1 AND 128),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,                                      -- soft-delete
  UNIQUE (project_id, name),
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX topics_project ON topics(project_id);
CREATE INDEX topics_archived ON topics(archived_at);

-- PRESENTATION (non-core, persisted + shared): display prefs for topics.
-- Separated from core so the essential model stays free of UI concerns.
-- Losing this layer only loses how topics are shown, never the topics themselves.
CREATE TABLE topic_display (
  topic_id  TEXT    PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,                    -- order within the project
  color     TEXT    CHECK (color IS NULL
                           OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')
);

-- CORE: append-only audit trail. One row per meaningful state change, written
-- in the same transaction as the change it records. The same table exists in
-- each per-project DB (PROJECT.md); `clidos audit` merges them by `ts` into one
-- timeline. `project_id` scopes an event to a project (NULL only for system-wide
-- events). Core holds identity + time only — never updated or deleted.
CREATE TABLE audit_log (
  id           TEXT    PRIMARY KEY,                          -- random id
  ts           INTEGER NOT NULL,                             -- UTC unix ms (event time)
  project_id   TEXT,                                         -- project this event concerns
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

- **Core vs presentation.** The core schema holds identity, relationships, and
  lifecycle only. UI constructs — topic ordering (`position`) and `color` — live
  in the separate `topic_display` table (same DB, real FK + `ON DELETE CASCADE`).
  They are persisted and shared across clients, but are not core: dropping
  `topic_display` loses only display prefs, never the topics themselves.
- **Topics are never hard-deleted, only archived.** This is load-bearing: the
  per-project `task_topics.topic_id` (see `PROJECT.md`) references `topics.id`
  across database files, where SQLite cannot enforce a foreign key. Because
  topics are never destroyed, every such reference always resolves. The
  application must assert this on every deletion path.
- `projects` -> `topics` is a real FK with `ON DELETE RESTRICT`: a project
  cannot be deleted while it owns topics. Archive the topics, or archive the
  project, instead.
- Projects and topics are soft-deleted via `archived_at`; history is preserved.
- Identifiers are 160-bit random ids (`TEXT`, 32-char Crockford base32), generated locally — no central id assignment.
- **There is no implicit default topic.** A project may have zero topics.
  "Unassigned" is not a row in this file; it is the absence of a task's topic
  association, materialized as a virtual group by the client.
- **Audit trail is append-only.** `audit_log` records every meaningful state
  change — project/topic lifecycle here, task/column changes in each project's
  own `audit_log` (PROJECT.md) — as one row inserted in the same transaction as
  the change, never updated or deleted. `clidos audit` merges this file's
  `audit_log` with every project's into one timeline ordered by `ts`; that
  cross-file merge is why the UTC-unix-ms timestamp invariant (DESIGN.md, rule
  1) is load-bearing.
