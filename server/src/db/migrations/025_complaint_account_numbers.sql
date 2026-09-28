-- ---------------------------------------------------------------------------
-- 025: the account numbers a complaint is about
--
-- Two complaints to the same supplier about different properties carry
-- different account numbers, and one complaint's emails all carry the same
-- one. So account numbers are the surest way to tell whether an email, a
-- found thread or another complaint is about THIS complaint. They are read
-- off the emails when a complaint is imported and kept here; matching
-- (orgMatch.js#refsOf / issueMatch) uses them alongside the references and
-- the property.
-- ---------------------------------------------------------------------------

ALTER TABLE complaints ADD COLUMN IF NOT EXISTS account_numbers TEXT[] NOT NULL DEFAULT '{}';

-- When the account numbers were last read off the emails (by import, or by
-- the backfill that went back through everything already on file), so each
-- complaint and each found thread is read for them once.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS accounts_read_at TIMESTAMPTZ;
ALTER TABLE complaint_import_candidates ADD COLUMN IF NOT EXISTS accounts_read_at TIMESTAMPTZ;
