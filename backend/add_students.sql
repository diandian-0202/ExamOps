CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  level        TEXT    NOT NULL DEFAULT 'average',
  prompt       TEXT    DEFAULT '',
  assigned_kcs TEXT    DEFAULT '[]',
  created_at   TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
