-- ---------------------------------------------------------------------------
-- 005: Inbound email logging for complaints (Microsoft Graph)
--   - complaints.ref_code: a short reference to put in the email subject so a
--     CC'd/BCC'd email can be matched back to its complaint
--   - complaint_emails: emails ingested from the shared mailbox, matched to a
--     complaint (or left unmatched for review), deduped by graph_id
-- ---------------------------------------------------------------------------

ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ref_code TEXT;

-- Backfill a code for existing complaints.
UPDATE complaints
   SET ref_code = 'GC-C-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
 WHERE ref_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_complaints_ref_code
  ON complaints (ref_code) WHERE ref_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS complaint_emails (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID REFERENCES complaints (id) ON DELETE SET NULL,
  graph_id     TEXT UNIQUE,          -- Microsoft Graph message id (dedup key)
  message_id   TEXT,                 -- RFC internet message id
  subject      TEXT,
  sender_name  TEXT,
  sender_email TEXT,
  to_addresses TEXT[],
  body_preview TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction    TEXT NOT NULL DEFAULT 'inbound',
  match_method TEXT NOT NULL DEFAULT 'unmatched',
    -- ref_code | reference | org_email | property | unmatched
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complaint_emails_complaint
  ON complaint_emails (complaint_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaint_emails_unmatched
  ON complaint_emails (received_at DESC) WHERE complaint_id IS NULL;
