-- CallHome D1 schema

CREATE TABLE IF NOT EXISTS contacts (
  slug        TEXT PRIMARY KEY,
  salt        TEXT NOT NULL,
  iv          TEXT NOT NULL,
  data        TEXT NOT NULL,       -- AES-256-GCM ciphertext (base64)
  verifier    TEXT NOT NULL,       -- PBKDF2 write-auth hash (base64)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,   -- "type:ip:window_bucket"
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL    -- unix seconds, for TTL logic
);

-- Index for fast cleanup of expired rate-limit rows (optional maintenance)
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
