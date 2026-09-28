-- ---------------------------------------------------------------------------
-- 032: the same document once
--
-- A file that arrives on several emails (a letter forwarded again, a photo
-- carried on every reply) was saved once per email, so a complaint could list
-- the same scan a dozen times and send it to the AI more than once. Each
-- document's content hash is kept, a file already on the complaint is not
-- saved again, and the list and the AI both show each document once.
-- Files already saved twice are left on disk and hashed in the background
-- (services/attachments.js#backfillAttachmentHashes); nothing is deleted.
-- ---------------------------------------------------------------------------

ALTER TABLE complaint_attachments ADD COLUMN IF NOT EXISTS sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_complaint_attachments_hash ON complaint_attachments (complaint_id, sha256);
