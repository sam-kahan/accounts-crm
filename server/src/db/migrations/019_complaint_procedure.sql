-- ---------------------------------------------------------------------------
-- 019: Complaint procedures that can be followed step by step
--
-- organisations — what a body's procedure says beyond "N working days":
--   procedure_ref          their document's own name/version ("PRO39 V7")
--   stage1_clock           'receipt' | 'acknowledgement' — some procedures count
--                          the Stage 1 outcome from the day they acknowledge
--   ombudsman_after_weeks  may refer this many weeks after the complaint was
--                          made, even with no final response
--   referral_from          'raised' | 'final_response' — what the referral
--                          window is counted from
--   unconfirmed            fields research couldn't confirm for THIS body
--   procedure_evidence     {field: "quoted sentence"} — where each value came from
--   verified_at/_by        a person checked the values against the procedure
--   NULL on any of these means "not stated", and the type default applies.
--
-- organisation_documents — the procedure document itself, kept on the record.
--
-- complaints:
--   stage_started_on       when the current stage's clock started (the Stage 2
--                          request date for Stage 2); NULL reads as raised_on
--   response_due_manual    response_due was typed in, so recalculating must
--                          leave it alone
--   final_response_on      their final (Stage 2) response — the referral window
--                          of many schemes runs from it
-- ---------------------------------------------------------------------------

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS procedure_ref TEXT,
  ADD COLUMN IF NOT EXISTS stage1_clock TEXT,
  ADD COLUMN IF NOT EXISTS ombudsman_after_weeks INTEGER,
  ADD COLUMN IF NOT EXISTS referral_from TEXT,
  ADD COLUMN IF NOT EXISTS unconfirmed TEXT[],
  ADD COLUMN IF NOT EXISTS procedure_evidence JSONB,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by TEXT;

ALTER TABLE organisations
  ADD CONSTRAINT organisations_stage1_clock_check
    CHECK (stage1_clock IS NULL OR stage1_clock IN ('receipt', 'acknowledgement')),
  ADD CONSTRAINT organisations_referral_from_check
    CHECK (referral_from IS NULL OR referral_from IN ('raised', 'final_response'));

CREATE TABLE IF NOT EXISTS organisation_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mimetype        TEXT,
  size_bytes      INTEGER,
  storage_path    TEXT NOT NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organisation_documents_org
  ON organisation_documents (organisation_id, uploaded_at DESC);

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS stage_started_on DATE,
  ADD COLUMN IF NOT EXISTS response_due_manual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS final_response_on DATE;

-- Stage 1 started when the complaint was raised. A complaint already past
-- Stage 1 started Stage 2 on its escalation (the only record of that date is
-- the timeline entry the escalate route writes).
UPDATE complaints c
   SET stage_started_on = COALESCE(
         CASE WHEN c.stage = 'stage_1' THEN NULL ELSE (
           SELECT max(e.event_date) FROM complaint_events e
            WHERE e.complaint_id = c.id AND e.type = 'escalated'
              AND e.note = 'Escalated to Stage 2'
         ) END,
         c.raised_on)
 WHERE c.stage_started_on IS NULL;

-- A clear record: who logged each timeline entry, and whether each email
-- that arrived has been looked at and what it turned out to be.
ALTER TABLE complaint_events ADD COLUMN IF NOT EXISTS created_by TEXT;

ALTER TABLE complaint_emails
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_as TEXT,   -- acknowledgement | response | correspondence
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- Emails already on file were logged before this and have been seen.
UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = 'correspondence'
 WHERE reviewed_at IS NULL;
