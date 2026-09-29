-- When an email was handed to the mail server. "It went" (a send a restart
-- cut short) dates the email and its step from this, not from the day
-- someone confirmed it went, or the restart itself.
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
