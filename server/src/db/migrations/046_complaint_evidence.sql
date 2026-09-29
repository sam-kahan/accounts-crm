-- What every ombudsman asks for and nothing else on a complaint records:
-- the outcome we want (a refund, a corrected account, compensation) and any
-- money lost or extra costs. Kept as the complaint goes along, so the
-- referral isn't written from memory months later.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS outcome_wanted TEXT;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS losses TEXT;
