-- Queue table for when the global daily page limit is reached.
-- Entries are promoted to contacts FIFO by the nightly cron job.
CREATE TABLE IF NOT EXISTS queue (
  slug       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  data       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  day_bucket INTEGER NOT NULL,  -- YYYYMMDD of the day it was queued
  position   INTEGER NOT NULL,  -- FIFO order within that day
  queued_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_day_pos ON queue (day_bucket, position);

-- Drop the notify_topic column from contacts (no longer used)
ALTER TABLE contacts DROP COLUMN IF EXISTS notify_topic;
