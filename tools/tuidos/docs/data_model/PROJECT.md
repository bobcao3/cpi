# Per-project state — `state.sqlite`

Stored at `~/.local/state/tuidos/projects/<project-id>/state.sqlite`, one file
per project. Holds that project's kanban columns, tasks, each task's optional
conversation thread and media, and the many-to-many link between tasks and
global topics. A card is a task rendered on the board; its content is an
optional summary (`tasks.description`) plus a thread of messages
(`card_messages`).

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
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,                                         -- soft-delete / tombstone
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX columns_archived ON columns(archived_at);

-- CORE: tasks. Holds identity, status, and semantic fields only; on-board
-- ordering is presentation (task_display), not core. A task's body and
-- conversation live in card_messages (below); `description` here is an
-- optional at-a-glance summary, not the body.
CREATE TABLE tasks (
  id            TEXT    PRIMARY KEY,                          -- id
  title         TEXT    NOT NULL
                        CHECK (length(title) BETWEEN 1 AND 256),
  description   TEXT    CHECK (description IS NULL
                        OR length(description) BETWEEN 1 AND 1024),  -- optional summary
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

-- CORE: a task's conversation thread — the card's content. The body is the
-- first message by (created_at, id) ordering (no flag, no separate body
-- column); the rest are the conversation. A task with zero rows is title-only
-- (no body, no thread): the thread is optional. author holds the poster's
-- identity — currently the VCS string "Name <email>" (resolved from
-- git/jujutsu user.name and user.email, with a user@hostname fallback); it
-- becomes the peer id once P2P identity lands (like tasks.assignee). Edits
-- touch content/updated_at; deletes are archived_at tombstones.
CREATE TABLE card_messages (
  id          TEXT    PRIMARY KEY,                          -- id
  task_id     TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author      TEXT,                                        -- poster identity "Name <email>" from VCS config; peer id once P2P identity lands
  content     TEXT    NOT NULL CHECK (length(content) BETWEEN 1 AND 16384),
  created_at  INTEGER NOT NULL,                            -- UTC unix ms; ordering key
  updated_at  INTEGER NOT NULL,                            -- == created_at until edited
  archived_at INTEGER,                                     -- tombstone: message deleted
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX card_messages_task ON card_messages(task_id);

-- CORE: media attached to a message (the unit of content). Bytes live
-- content-addressed on disk at projects/<project-id>/media/<content_hash>;
-- this row is the reference + metadata only. content_hash = SHA-256 hex of the
-- bytes: dedup, integrity, and merge-safe across P2P nodes (same content ->
-- same path -> no conflict; any peer can serve it, verified by hash).
CREATE TABLE message_media (
  id            TEXT    PRIMARY KEY,                       -- id
  message_id    TEXT    NOT NULL REFERENCES card_messages(id) ON DELETE CASCADE,
  content_hash  TEXT    NOT NULL,                          -- SHA-256 hex -> media/<content_hash>
  filename      TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 256),
  mime_type     TEXT,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at    INTEGER NOT NULL,                          -- UTC unix ms
  archived_at   INTEGER,                                   -- tombstone
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);
CREATE INDEX message_media_message ON message_media(message_id);
CREATE INDEX message_media_hash ON message_media(content_hash);

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

-- CORE: append-only audit trail for THIS project's task/column/message/media
-- changes. The same table exists in the global DB (GLOBAL.md) for project/topic
-- lifecycle; `clidos audit` (or `clidos project audit <project>`) merges them
-- by `ts`.
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

- **Core vs presentation.** Core (`columns`, `tasks`, `task_topics`,
  `card_messages`, `message_media`) holds identity, status, relationships, and
  content only. On-board ordering — `column_display.position` and
  `task_display.position` — is presentation: persisted and shared, but non-core,
  each a 1:1 row with a real FK + `ON DELETE CASCADE`. Board rendering is
  deferred (see `DESIGN.md`); these tables only store the prefs.
- **A task has exactly one column** (`column_id NOT NULL`, `ON DELETE RESTRICT`)
  and **zero or more topics**. A project is initialized with at least one column
  (e.g. Backlog, In Progress, Done) so a status always exists. Columns are
  archived (`archived_at` tombstone, never hard-deleted); you must move a
  column's active tasks elsewhere before archiving it.
- **Card content = summary + thread + media.** `tasks.description` is an
  optional, hand-written at-a-glance summary (not a cache of anything). The body
  and conversation are a thread of `card_messages`, ordered by
  `(created_at, id)` — the same ordering the `audit_log` uses — so the **body is
  the first message** (a rendering convention, no flag) and the rest are the
  conversation. The thread is optional: a task with zero `card_messages` is
  title-only. Editing the body edits that first message (`updated_at` moves;
  `created_at` and ordering stay stable); deleting a message is an `archived_at`
  tombstone, so the thread never loses its shape on sync.
- **Media is content-addressed, never in the DB.** Bytes are stored at
  `projects/<project-id>/media/<content_hash>` (`content_hash` = SHA-256 hex),
  never as BLOBs in SQLite — BLOBs would bloat the DB, break WAL/sync, and
  thrash the cache. The `message_media` row is the reference + metadata only:
  small, so it syncs via the normal LWW/append path, while the bytes sync on the
  P2P data plane by hash. The hash guarantees the row and blob match and that
  any peer serving it is correct. Removing media is an `archived_at` tombstone;
  blob GC (delete blobs with no live refs) is deferred, not v1. Media attaches
  to a message (the unit of content), so body media is media on the first
  message.
- **"Unassigned" is the implicit topic.** A task with no `task_topics` rows is
  unassigned; the client renders such tasks under a virtual "Unassigned" group
  when grouping by topic. There is no `#random` or default-topic row anywhere —
  topics are always explicit, user-created rows in `GLOBAL.md`.
- `task_topics.task_id` is a real FK with `ON DELETE CASCADE`: deleting a task
  drops its associations. `task_topics.topic_id` is a cross-DB reference to
  `global.topics(id)` — not a FK; it stays valid because global topics are never
  hard-deleted. `card_messages` and `message_media` cascade the same way:
  deleting a task drops its thread, and deleting a message drops its media.
- When grouping by topic, sort by `priority` / `created_at`; per-topic manual
  drag-order is not stored in v1 (add a `position` column to a topic-scoped view
  only if later required).
- Identifiers are 160-bit random ids (`TEXT`, 32-char Crockford base32).
- **Audit trail is append-only.** This file's `audit_log` records task, column,
  message, and media changes for this project; project/topic lifecycle is
  audited in GLOBAL.md. Rows are inserted in the same transaction as the change,
  never updated or deleted. Actions include `task.*`, `column.*`,
  `message.create|update|archive`, and `media.create|archive`. `clidos audit`
  (and `clidos project audit <project>`) merges all files by `ts` (UTC unix ms).
