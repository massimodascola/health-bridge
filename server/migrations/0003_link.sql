-- The coach's weekly message was removed on 2026-10-05: the coach reads data when asked, from the private link (/link/<SHARE_TOKEN>).
DROP TABLE coach_messages;

-- Who read the summary: "app" (screen "What the coach sees") or "link" (coach via private link). The user agent is used to identify who opened the link.
ALTER TABLE summary_reads ADD COLUMN client TEXT;
ALTER TABLE summary_reads ADD COLUMN user_agent TEXT;
