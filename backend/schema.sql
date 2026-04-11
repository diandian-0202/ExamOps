-- ExamOps D1 数据库 Schema
-- 初始化命令: wrangler d1 execute examops --file=schema.sql

CREATE TABLE IF NOT EXISTS questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic           TEXT    NOT NULL,
  objective       TEXT,
  format          TEXT    NOT NULL DEFAULT 'MCQ',   -- MCQ | Select Multiple | Free Response
  difficulty      INTEGER DEFAULT 5,
  num_distractors INTEGER DEFAULT 4,
  question_text   TEXT,
  options         TEXT,        -- JSON: [{"text":"...","is_correct":true}, ...]
  explanation     TEXT,
  status          TEXT    DEFAULT 'draft',           -- draft | reviewed | approved
  in_bank         INTEGER DEFAULT 0,                 -- 0 = false, 1 = true
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
CREATE INDEX IF NOT EXISTS idx_questions_status   ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank     ON questions(in_bank);

-- API 调用计数（单行，id 固定为 1）
CREATE TABLE IF NOT EXISTS api_usage (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  call_count INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO api_usage (id, call_count) VALUES (1, 0);
