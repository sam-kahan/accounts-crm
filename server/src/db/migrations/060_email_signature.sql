-- ---------------------------------------------------------------------------
-- 060: The full email signature, signed by the person who sends.
--
-- The details a signature carries beyond name and job title: the letters
-- after their name ("MAAT"), and their numbers. Each line shows only when set.
-- Each person sets their own (My signature); an administrator can too.
--
-- complaint_outbox.sender_id: who pressed Send, so the email (which goes in
-- the background) carries THAT person's signature. NULL on emails queued
-- before this: they go as they were written.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS post_nominals TEXT,
  ADD COLUMN IF NOT EXISTS direct_line TEXT,
  ADD COLUMN IF NOT EXISTS office_phone TEXT,
  ADD COLUMN IF NOT EXISTS mobile TEXT;

ALTER TABLE complaint_outbox
  ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES users(id) ON DELETE SET NULL;
