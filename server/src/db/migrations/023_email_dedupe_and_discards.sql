-- ---------------------------------------------------------------------------
-- 023: Each email once, and a memory of what was ruled out
--
-- complaint_emails.message_id becomes unique (where set): the same email seen
-- in two mailboxes, or by two readers at once, is stored once. Any copies
-- already on file keep their row but have the duplicate id marked, so the
-- index can be built without deleting anything.
--
-- complaint_email_discards — emails from a watched mailbox the AI read and
-- found unrelated to any complaint. Remembered by message id so they are not
-- stored, read and paid for again on every check.
--
-- complaint_import_candidates.message_ids — the emails in a found thread, so
-- the same thread found in two mailboxes is recognised as one.
-- 'importing' joins the candidate statuses while an import runs.
-- ---------------------------------------------------------------------------

UPDATE complaint_emails e SET message_id = e.message_id || '#dup-' || e.id
 WHERE e.message_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM complaint_emails o
                WHERE o.message_id = e.message_id AND (o.created_at, o.id) < (e.created_at, e.id));

DROP INDEX IF EXISTS idx_complaint_emails_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_complaint_emails_message_id
  ON complaint_emails (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS complaint_email_discards (
  message_id    TEXT PRIMARY KEY,
  mailbox       TEXT,
  discarded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE complaint_import_candidates
  ADD COLUMN IF NOT EXISTS message_ids TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_import_candidates_message_ids
  ON complaint_import_candidates USING gin (message_ids);

-- How many times an email has been through processing: a read that keeps
-- failing is retried a few times, not forever.
ALTER TABLE complaint_emails ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
