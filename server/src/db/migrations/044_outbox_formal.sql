-- "Raise it as a formal complaint": an email queued from a complaint the
-- emails show was never formally made. Once it has gone, the complaint is
-- started from that day (Stage 1, its deadlines from then), and the earlier
-- emails stay as the background that led to it. Nothing changes if it fails.
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS then_formal BOOLEAN NOT NULL DEFAULT false;
