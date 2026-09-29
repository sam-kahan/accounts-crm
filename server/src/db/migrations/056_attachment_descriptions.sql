-- What each document on a complaint is, in one line, written by the AI the
-- first time it is needed ("Summons dated 15 Sep 2026 for £684.24") and kept,
-- so the AI can choose which documents go with an email from their
-- descriptions rather than their file names, without reading them again.
-- described_at marks that it was tried (an unreadable file isn't tried again).
ALTER TABLE complaint_attachments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE complaint_attachments ADD COLUMN IF NOT EXISTS described_at TIMESTAMPTZ;
