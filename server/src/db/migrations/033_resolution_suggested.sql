-- ---------------------------------------------------------------------------
-- 033: an email that says it's been resolved
--
-- When an email on a complaint reads as the matter having been put right (the
-- fee removed, the refund made, the bill issued, the complaint upheld and
-- closed), the complaint is NOT closed automatically — closing ends its
-- deadlines and drops it from every list — but it is flagged "Looks resolved"
-- with what the email said, on the complaint, in the list and in the morning
-- email, until a person confirms it (Mark resolved) or says it isn't yet.
--   resolution_suggested  { email_id, subject, on, outcome, party_id, by_us, at }
-- ---------------------------------------------------------------------------

ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolution_suggested JSONB;
