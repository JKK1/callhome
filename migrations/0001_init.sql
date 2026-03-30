CREATE TABLE IF NOT EXISTS contacts (
  slug       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  data       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-IP rate limiting buckets (short-lived, cleaned up on use)
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

-- Queue for when the rolling 24h limit is reached.
-- Drained FIFO at the top of every create request.
CREATE TABLE IF NOT EXISTS queue (
  slug      TEXT PRIMARY KEY,
  salt      TEXT NOT NULL,
  iv        TEXT NOT NULL,
  data      TEXT NOT NULL,
  verifier  TEXT NOT NULL,
  queued_at TEXT NOT NULL   -- ISO timestamp, used for FIFO ordering
);

CREATE INDEX IF NOT EXISTS idx_queue_queued_at ON queue (queued_at);
