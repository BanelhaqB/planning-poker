-- D1 schema for Poker Sizing history.
-- Apply locally:  wrangler d1 execute planning-poker --local --file=./schema.sql
-- Apply remote:   wrangler d1 execute planning-poker --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  topic       TEXT,
  scale       TEXT,               -- JSON array of the scale used
  average     REAL,               -- null if no numeric votes
  consensus   INTEGER NOT NULL DEFAULT 0,   -- 0/1
  voter_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  round_id    TEXT NOT NULL,
  voter_name  TEXT NOT NULL,
  value       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_room ON rounds(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_votes_round ON votes(round_id);
