-- Raw HealthKit samples, one per row. uuid is the HealthKit identifier:
-- if the app resends the same sample, the row is overwritten, never duplicated.
-- Dates in UTC, ISO 8601 format without milliseconds (2026-10-04T14:11:00Z).
CREATE TABLE samples (
  uuid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  value REAL,
  unit TEXT,
  source TEXT,
  meta TEXT
) WITHOUT ROWID;

CREATE INDEX samples_type_start ON samples (type, start_at);

-- Daily totals computed by HealthKit on the phone (steps, energy, distance).
-- iPhone and Watch count the same steps: only HealthKit can remove duplicates,
-- so these totals are not recalculated from raw samples.
-- day is the phone's local date (2026-10-04).
CREATE TABLE daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  PRIMARY KEY (day, metric)
) WITHOUT ROWID;

-- Upload log: used to check whether synchronization is working.
CREATE TABLE ingests (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  samples INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  daily INTEGER NOT NULL
);
