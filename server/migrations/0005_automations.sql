-- Automations (2026-10-06, modeled after Health Auto Export): data packages with a
-- name, chosen by category (src/categories.ts). Each is a private link with its
-- token (destination 'link') or a delivery to a web address every N hours ('webhook').
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  categories TEXT NOT NULL,      -- JSON array of categories
  days INTEGER NOT NULL,         -- summary period, from 1 to 31 days
  format TEXT NOT NULL,          -- 'text' (for ChatGPT) or 'json'
  destination TEXT NOT NULL,     -- 'link' or 'webhook'
  webhook_url TEXT,
  webhook_header TEXT,           -- optional, "Name: value"
  every_hours INTEGER NOT NULL DEFAULT 24,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT
);

-- Log of automation webhook deliveries: outcome and detail.
CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY,
  automation_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, id);

-- Reads of automation links are in summary_reads with client
-- 'automation:<id>': the index serves to find the latest for each.
CREATE INDEX summary_reads_by_client ON summary_reads (client, id);
