-- ---------------------------------------------------------------------------
-- 020: Forward it and the system does the rest
--
-- complaint_emails
--   body_text     the whole email (the preview alone was ~250 characters, and
--                 for a forward that was mostly the "From / Sent" header)
--   analysis      what the AI made of it: what kind of email, who really wrote
--                 it, the date THEY sent it (not the day it was forwarded),
--                 their reference, a summary, and how sure it is
--   analysed_at / analysis_error
--   applied       what was recorded automatically from it, with the values it
--                 replaced, so it can be undone exactly
--   complaint_id is already nullable: an email sent to the general complaints
--   inbox that can't be matched to a complaint waits, unfiled, for a person.
--
-- complaint_attachments.source_email_id — a document that arrived attached to
--   an email, so the record says where it came from.
--
-- complaints.ai_review — the assistant's standing review of the complaint
--   (where it stands, the next step, a draft email), refreshed whenever
--   something changes; ai_review_status is the status it was written against,
--   so the nightly job can tell which reviews the calendar has overtaken.
-- ---------------------------------------------------------------------------

ALTER TABLE complaint_emails
  ADD COLUMN IF NOT EXISTS body_text TEXT,
  ADD COLUMN IF NOT EXISTS analysis JSONB,
  ADD COLUMN IF NOT EXISTS analysed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS analysis_error TEXT,
  ADD COLUMN IF NOT EXISTS applied JSONB;

ALTER TABLE complaint_attachments
  ADD COLUMN IF NOT EXISTS source_email_id UUID REFERENCES complaint_emails (id) ON DELETE SET NULL;

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS ai_review JSONB,
  ADD COLUMN IF NOT EXISTS ai_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_review_status TEXT,
  ADD COLUMN IF NOT EXISTS ai_review_error TEXT;
