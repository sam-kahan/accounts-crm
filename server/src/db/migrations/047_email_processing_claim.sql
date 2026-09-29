-- An email being read and filed is claimed while it is (processing_at): the
-- five-minute check and a slow earlier one, or a retry, never work on the
-- same email at once (each would pay for the read and record it twice). A
-- claim older than 15 minutes is taken as abandoned (a restart).
ALTER TABLE complaint_emails ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
