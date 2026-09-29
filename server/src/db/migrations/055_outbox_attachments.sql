-- The complaint's documents chosen to go with an email sent from it (the
-- summons, the bill, a letter). Read from disk when it is sent, and named in
-- the email itself ("Attached: …") so the copy on the complaint says what went.
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS attachment_ids UUID[] NOT NULL DEFAULT '{}';
