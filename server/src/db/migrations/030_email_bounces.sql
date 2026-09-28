-- ---------------------------------------------------------------------------
-- 030: emails that bounced
--
-- An email that bounces never reached them, so a deadline counted from it, or a
-- chaser nobody received, is worse than no email at all. Each bounce is kept
-- here and flagged — on the complaint it was about, on the organisation whose
-- address it is, and on the Complaints page — until a person has looked into
-- it and says so (resolved_at/_by, with what they found).
--
-- Two ways in:
--   mailbox   a bounce message ("Undeliverable: …") arriving in a mailbox the
--             system reads (the watched mailboxes and the catch-all) — for
--             emails sent from Outlook
--   smtp2go   SMTP2GO's bounce webhook — for emails sent from the CRM, whose
--             bounces go to SMTP2GO rather than to us
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_bounces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address         TEXT NOT NULL,             -- the address that failed, lower case
  reason          TEXT,                      -- what the receiving server said
  source          TEXT NOT NULL,             -- mailbox | smtp2go
  bounced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject         TEXT,                      -- of the email that bounced, where known
  complaint_id    UUID REFERENCES complaints (id) ON DELETE SET NULL,
  -- The bounce message (mailbox) or event (smtp2go) it came from, so the same
  -- one read twice is recorded once.
  source_ref      TEXT,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  resolution      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_bounces_source
  ON email_bounces (source, source_ref, address) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_bounces_open ON email_bounces (address) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_bounces_complaint ON email_bounces (complaint_id);
