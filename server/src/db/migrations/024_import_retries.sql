-- ---------------------------------------------------------------------------
-- 024: automatic import tries again
--
-- A found complaint whose import failed was left for a person, even with
-- "Import automatically" ticked. Most failures are passing (the mailbox or the
-- AI busy for a moment), so automatic import now tries again, up to three
-- tries in all and at least half an hour apart; import_attempts and
-- last_attempt_at record that.
--
-- Rows put back by a restart before this change carry a note that made
-- automatic import pass them by for good. A restart isn't a failure of the
-- complaint: the note is cleared so they are taken up again.
-- ---------------------------------------------------------------------------

ALTER TABLE complaint_import_candidates
  ADD COLUMN IF NOT EXISTS import_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

UPDATE complaint_import_candidates SET error = NULL
 WHERE status = 'pending' AND error LIKE 'The import was interrupted by a restart%';
