-- ---------------------------------------------------------------------------
-- 006: Evidence attachments, outbound-email support, and escalation flags
--   - complaint_attachments: uploaded evidence (letters, PDFs, photos, portal
--     screenshots), with optional extracted text for the AI assistant
--   - complaints.ombudsman_ready: set when a final response / deadlock is
--     detected, so the complaint surfaces as ready to escalate
--   - complaints.imported: marks complaints brought in from before the system
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS complaint_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id   UUID NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mimetype       TEXT,
  size_bytes     INTEGER,
  storage_path   TEXT NOT NULL,
  extracted_text TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint
  ON complaint_attachments (complaint_id, uploaded_at DESC);

ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ombudsman_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS imported BOOLEAN NOT NULL DEFAULT false;
