-- ---------------------------------------------------------------------------
-- 031: re-checking a complaint against its emails
--
-- Complaints imported from past emails were mostly left at Stage 1. The
-- re-check searches the mailboxes for every account number and reference on
-- a complaint, reads all its emails together, and moves it to where the
-- emails show it has got to (forward only; blank dates filled; a recorded
-- date that differs is reported, never overwritten).
--   rechecked_at       when it was last re-checked
--   recheck_signature  the emails it was read against (count + newest), so a
--                      complaint with nothing new is not read (or paid for) again
--   last_recheck       what the last re-check changed, with the values it
--                      replaced, so Undo puts them back exactly
-- ---------------------------------------------------------------------------

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS rechecked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recheck_signature TEXT,
  ADD COLUMN IF NOT EXISTS last_recheck JSONB;
