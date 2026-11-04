-- Traces of the coach's weekly round, to verify the chain works.
-- Each summary read (done by the Shortcut, or the "What the coach sees" screen).
CREATE TABLE summary_reads (
  id INTEGER PRIMARY KEY,
  read_at TEXT NOT NULL,
  days INTEGER NOT NULL
);

-- Each coach response, sent by the app when the Shortcut delivers it.
CREATE TABLE coach_messages (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  message TEXT NOT NULL
);
