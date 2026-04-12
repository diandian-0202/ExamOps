-- ExamOps D1 Schema

CREATE TABLE IF NOT EXISTS classes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO classes (id, name) VALUES (1, 'EECS 485'), (2, 'EECS 370');

CREATE TABLE IF NOT EXISTS course_chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id  INTEGER NOT NULL REFERENCES classes(id),
  source    TEXT    DEFAULT 'lecture',  -- 'lecture' or 'exam'
  topic_tag TEXT,                       -- e.g. 'Networking', 'MapReduce'
  content   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id        INTEGER REFERENCES classes(id),
  topic           TEXT    NOT NULL,
  objective       TEXT,
  format          TEXT    NOT NULL DEFAULT 'MCQ',
  difficulty      TEXT    DEFAULT 'Common Mistakes',
  num_distractors INTEGER DEFAULT 4,
  question_text   TEXT,
  options         TEXT,
  explanation     TEXT,
  status          TEXT    DEFAULT 'draft',
  in_bank         INTEGER DEFAULT 0,
  created_at      TEXT    DEFAULT (datetime('now')),
  updated_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS question_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  question_text TEXT,
  options       TEXT,
  explanation   TEXT,
  status        TEXT,
  author        TEXT    DEFAULT 'Instructor',
  created_at    TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_versions_question ON question_versions(question_id);
CREATE INDEX IF NOT EXISTS idx_questions_status  ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank    ON questions(in_bank);
CREATE INDEX IF NOT EXISTS idx_questions_class   ON questions(class_id);
CREATE INDEX IF NOT EXISTS idx_chunks_class      ON course_chunks(class_id);

CREATE TABLE IF NOT EXISTS api_usage (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  call_count INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO api_usage (id, call_count) VALUES (1, 0);
