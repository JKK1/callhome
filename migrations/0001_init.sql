CREATE TABLE IF NOT EXISTS contacts (
  slug       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  data       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

CREATE TABLE IF NOT EXISTS queue (
  slug       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  data       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  day_bucket INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  queued_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_day_pos ON queue (day_bucket, position);
