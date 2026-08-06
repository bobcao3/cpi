// DDL for the two SQLite tiers. See docs/data_model/GLOBAL.md and
// docs/data_model/PROJECT.md. CREATE ... IF NOT EXISTS keeps init idempotent.

// Append-only audit trail — present in BOTH tiers so `clidos audit` can merge a
// global timeline across files by ts (UTC unix ms). See docs/data_model/*.md.
export const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT    PRIMARY KEY,
  ts            INTEGER NOT NULL,
  project_id    TEXT,
  action        TEXT    NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  entity_type   TEXT    NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 32),
  entity_id     TEXT,
  summary       TEXT    NOT NULL CHECK (length(summary) BETWEEN 1 AND 512)
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_project ON audit_log(project_id);
`;

export const GLOBAL_DDL =
  `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE
                       CHECK (length(name) BETWEEN 1 AND 128),
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX IF NOT EXISTS projects_archived ON projects(archived_at);

CREATE TABLE IF NOT EXISTS topics (
  id           TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  UNIQUE (project_id, name),
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX IF NOT EXISTS topics_project ON topics(project_id);
CREATE INDEX IF NOT EXISTS topics_archived ON topics(archived_at);

CREATE TABLE IF NOT EXISTS topic_display (
  topic_id  TEXT    PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  color     TEXT    CHECK (color IS NULL
                           OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')
);
` + AUDIT_DDL;

export const PROJECT_DDL =
  `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS columns (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE
                      CHECK (length(name) BETWEEN 1 AND 64),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX IF NOT EXISTS columns_archived ON columns(archived_at);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL
                        CHECK (length(title) BETWEEN 1 AND 256),
  description   TEXT    CHECK (description IS NULL
                        OR length(description) BETWEEN 1 AND 1024),
  column_id     TEXT    NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
  priority      INTEGER CHECK (priority BETWEEN 0 AND 4),
  assignee      TEXT,
  estimate      INTEGER CHECK (estimate IS NULL OR estimate >= 0),
  due_at        INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  archived_at   INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_column ON tasks(column_id);

CREATE TABLE IF NOT EXISTS task_topics (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, topic_id)
);
CREATE INDEX IF NOT EXISTS task_topics_topic ON task_topics(topic_id);

-- A task's conversation thread: the body is the first message by (created_at,
-- id); the rest are the conversation. Optional (0 rows = title-only). See
-- docs/data_model/PROJECT.md.
CREATE TABLE IF NOT EXISTS card_messages (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author        TEXT,    -- poster identity "Name <email>" from VCS config (peer id once P2P identity lands)
  content       TEXT    NOT NULL CHECK (length(content) BETWEEN 1 AND 16384),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  CHECK (archived_at IS NULL OR archived_at >= updated_at)
);
CREATE INDEX IF NOT EXISTS card_messages_task ON card_messages(task_id);

-- Media attached to a message. Bytes are content-addressed on disk at
-- projects/<id>/media/<content_hash> (SHA-256 hex); this row is metadata only.
CREATE TABLE IF NOT EXISTS message_media (
  id            TEXT    PRIMARY KEY,
  message_id    TEXT    NOT NULL REFERENCES card_messages(id) ON DELETE CASCADE,
  content_hash  TEXT    NOT NULL,
  filename      TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 256),
  mime_type     TEXT,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);
CREATE INDEX IF NOT EXISTS message_media_message ON message_media(message_id);
CREATE INDEX IF NOT EXISTS message_media_hash ON message_media(content_hash);

CREATE TABLE IF NOT EXISTS column_display (
  column_id TEXT PRIMARY KEY REFERENCES columns(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_display (
  task_id  TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);
` + AUDIT_DDL;
