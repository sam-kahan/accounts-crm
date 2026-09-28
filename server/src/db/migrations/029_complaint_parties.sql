-- ---------------------------------------------------------------------------
-- 029: one complaint, more than one organisation
--
-- A debt collector chasing a supplier's bill (LCS for British Gas) is one
-- issue with two organisations, each running its own complaints procedure
-- with its own reference and its own clock. Two separate complaints would
-- split the emails, the account number and the review between them, when an
-- update from one nearly always changes things with the other.
--
-- The complaint row stays the MAIN organisation's track, exactly as before, so
-- every complaint with one organisation is unchanged. Each further
-- organisation is a row here carrying the same procedure fields as the
-- complaint itself (the rules engine reads either), so each has its own
-- reference, stage, acknowledgement, response and deadlines.
--
-- complaints.state stays 'open' while ANY organisation's track is open. When
-- the main organisation's track ends first, its stage says so
-- ('resolved'/'closed') and the complaint stays open for the others.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS complaint_parties (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id        UUID NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,
  organisation_id     UUID REFERENCES organisations (id) ON DELETE SET NULL,
  org_name            TEXT NOT NULL,
  org_type            TEXT NOT NULL DEFAULT 'other',
  -- How it relates to the main organisation, in words ("collecting the debt
  -- for British Gas"). Said on the page; decides nothing.
  relationship        TEXT,
  reference           TEXT,               -- THEIR reference for this complaint
  raised_on           DATE NOT NULL,      -- when the complaint was made to THEM
  channel             TEXT,
  stage               TEXT NOT NULL DEFAULT 'stage_1',
  state               TEXT NOT NULL DEFAULT 'open',
  stage_started_on    DATE,
  acknowledged_on     DATE,
  responded_on        DATE,
  final_response_on   DATE,
  response_due        DATE,
  response_due_manual BOOLEAN NOT NULL DEFAULT false,
  ombudsman_deadline  DATE,
  outcome             TEXT,
  closed_on           DATE,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT complaint_parties_stage_check
    CHECK (stage IN ('stage_1', 'stage_2', 'ombudsman', 'resolved', 'closed')),
  CONSTRAINT complaint_parties_state_check CHECK (state IN ('open', 'resolved', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_complaint_parties_complaint ON complaint_parties (complaint_id);
CREATE INDEX IF NOT EXISTS idx_complaint_parties_org ON complaint_parties (organisation_id);
-- The same saved organisation can't be on one complaint twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_complaint_parties_org
  ON complaint_parties (complaint_id, organisation_id) WHERE organisation_id IS NOT NULL;

CREATE TRIGGER trg_complaint_parties_updated_at
  BEFORE UPDATE ON complaint_parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which organisation's track a timeline entry or an email belongs to. NULL is
-- the main organisation (or the complaint as a whole), which is every row
-- written before this.
ALTER TABLE complaint_events
  ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES complaint_parties (id) ON DELETE SET NULL;
ALTER TABLE complaint_emails
  ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES complaint_parties (id) ON DELETE SET NULL;
