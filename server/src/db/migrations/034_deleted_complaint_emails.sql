-- ---------------------------------------------------------------------------
-- 034: deleting a complaint deletes its emails — and they stay gone
--
-- complaint_emails.complaint_id is ON DELETE SET NULL, so deleting a complaint
-- left every one of its emails behind, unfiled, in "Emails to file" (while the
-- Delete button said its emails would be deleted). Deleting now removes them
-- (routes/complaints.js), and remembers them so they aren't brought back in:
--   complaint_email_discards   each email's message id (already used by the
--                              watcher for mail it ruled out)
--   complaint_ignored_threads  the email threads the complaint was on, so a
--                              later reply in the same thread isn't filed or
--                              turned into a complaint again
-- It also clears up the emails already stranded that way: an unfiled email
-- whose match_method says it HAD been filed on a complaint can only have got
-- there by that complaint being deleted.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS complaint_ignored_threads (
  conversation_id TEXT PRIMARY KEY,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO complaint_email_discards (message_id, mailbox)
SELECT DISTINCT ON (message_id) message_id, source_mailbox FROM complaint_emails
 WHERE complaint_id IS NULL AND message_id IS NOT NULL
   AND match_method NOT IN ('inbox', 'watch', 'watch_new', 'unmatched')
ON CONFLICT DO NOTHING;

INSERT INTO complaint_ignored_threads (conversation_id, reason)
SELECT DISTINCT conversation_id, 'on a complaint that was deleted' FROM complaint_emails
 WHERE complaint_id IS NULL AND conversation_id IS NOT NULL
   AND match_method NOT IN ('inbox', 'watch', 'watch_new', 'unmatched')
ON CONFLICT DO NOTHING;

DELETE FROM complaint_emails
 WHERE complaint_id IS NULL
   AND match_method NOT IN ('inbox', 'watch', 'watch_new', 'unmatched');
