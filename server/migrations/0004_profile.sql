-- Personal data (date of birth, sex, height): sent by the app, or the export import. One row per entry.
CREATE TABLE profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
