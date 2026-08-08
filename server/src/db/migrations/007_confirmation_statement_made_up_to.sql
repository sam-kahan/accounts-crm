-- ---------------------------------------------------------------------------
-- 007: track the confirmation statement DATE (made-up-to), not just the
-- filing deadline.
--
-- Companies House exposes two confirmation-statement dates:
--   * next_made_up_to — the statement date; you can file from this date.
--   * next_due        — the filing deadline (typically 14 days later).
-- We remind on the made-up-to date (there's no reason to wait for the
-- deadline), so store it alongside the deadline, mirroring how accounts
-- already carry both next_made_up_to (year end) and next_due.
-- ---------------------------------------------------------------------------

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS confirmation_statement_next_made_up_to DATE;
