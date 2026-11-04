-- Which address was opened, with the token replaced by <t> (2026-10-10): helps
-- understand whether ChatGPT opens the link as-is or a variant.
ALTER TABLE summary_reads ADD COLUMN path TEXT;
