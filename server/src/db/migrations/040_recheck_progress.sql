-- Where the complaint page's re-check has got to (searching, waiting for
-- another search, reading the emails, writing the next steps), and how it
-- ended. The page follows this instead of guessing from the AI review's
-- time, so a re-check that failed or was cut off by a restart says so rather
-- than leaving the page on "Re-checking…".
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS recheck_progress JSONB;
