-- Calendar (2026-10-11). The app sends the iPhone calendars:
-- * kind 'busy': engagements for the next 14 days, only times, never the titles (choice by
--   the user: work engagement names do not leave the phone);
-- * kind 'planned': workouts from the "Workouts" calendar created by the app, with
--   title and notes written by the coach, from 14 days in the past forward.
-- On every upload the server deletes rows that end after "from" and inserts the new ones.
CREATE TABLE calendar_events (
  kind TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  notes TEXT
);
CREATE INDEX calendar_events_end ON calendar_events (end_at);

-- Last calendar upload, a single row.
CREATE TABLE calendar_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  received_at TEXT NOT NULL
);
