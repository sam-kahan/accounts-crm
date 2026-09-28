-- ---------------------------------------------------------------------------
-- 021: The system watches the mailbox, and can find past complaints in it
--
-- complaint_emails
--   conversation_id  the email thread it belongs to (Microsoft Graph). A reply
--                    in the same thread as an email already on a complaint is
--                    filed there with certainty — no address to copy in.
--   source_mailbox   which mailbox it was read from
--   Stored emails are de-duplicated on message_id (the same email copied to
--   two watched mailboxes is one email), so it gets an index.
--
-- app_settings — small settings people change from the app rather than the
--   server's .env: which mailboxes to watch, when it last checked and how that
--   went, and the progress of a past-complaints search.
--
-- complaint_import_candidates — email threads a past-complaints search found,
--   each read by the AI, waiting for a person to Import or Skip. A thread that
--   turned out not to be a complaint is kept as 'not_complaint' so it is never
--   read (and paid for) twice.
-- ---------------------------------------------------------------------------

ALTER TABLE complaint_emails
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS source_mailbox TEXT;

CREATE INDEX IF NOT EXISTS idx_complaint_emails_conversation
  ON complaint_emails (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaint_emails_message_id
  ON complaint_emails (message_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS complaint_import_candidates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox          TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  graph_ids        TEXT[] NOT NULL DEFAULT '{}',
  subject          TEXT,
  first_at         TIMESTAMPTZ,
  last_at          TIMESTAMPTZ,
  message_count    INTEGER NOT NULL DEFAULT 0,
  extracted        JSONB,
  status           TEXT NOT NULL DEFAULT 'pending',
    -- pending | imported | skipped | not_complaint | error
  complaint_id     UUID REFERENCES complaints (id) ON DELETE SET NULL,
  error            TEXT,
  decided_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_import_candidates_status
  ON complaint_import_candidates (status, first_at DESC);
