-- Workouts recorded in the app (2026-10-14): one row per session and one per set.
-- The app sends the last 60 sessions on every change: the server replaces those that
-- it receives (same id), so a corrected or removed set disappears here too.
CREATE TABLE training_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX training_sessions_start ON training_sessions (started_at);

CREATE TABLE training_sets (
  session_id TEXT NOT NULL,
  exercise TEXT NOT NULL,
  exercise_order INTEGER NOT NULL,
  target TEXT,
  set_index INTEGER NOT NULL,
  reps INTEGER,
  weight_kg REAL,
  seconds INTEGER,
  logged_at TEXT NOT NULL
);
CREATE INDEX training_sets_session ON training_sets (session_id);
CREATE INDEX training_sets_exercise ON training_sets (exercise, logged_at);
