CREATE TABLE IF NOT EXISTS knowledge_components (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL REFERENCES classes(id),
  name        TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  aliases     TEXT    DEFAULT '[]',
  created_at  TEXT    DEFAULT (datetime('now'))
);
