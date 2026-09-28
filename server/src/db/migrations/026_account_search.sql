-- ---------------------------------------------------------------------------
-- 026: every email about the account, on the complaint
--
-- Once a complaint's account number is known, the mailboxes are searched for
-- it and every email that quotes it is brought onto the complaint (the
-- account number is the complaint's key). accounts_searched records which
-- numbers (normalised: upper case, letters and digits only) have been searched
-- for, so each is searched once, and a number added later is searched then.
-- ---------------------------------------------------------------------------

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS accounts_searched TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS accounts_searched_at TIMESTAMPTZ;
