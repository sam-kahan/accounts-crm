-- ---------------------------------------------------------------------------
-- 004: Complaints module
--   organisations      — bodies you complain to (councils, suppliers, …) with a
--                        researched complaints-procedure profile
--   complaints         — a complaint against an organisation, with auto-computed
--                        statutory response deadlines and escalation windows
--   complaint_events   — the timeline / evidence trail per complaint
-- ---------------------------------------------------------------------------

-- --- organisations ---------------------------------------------------------
CREATE TABLE organisations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'council',
    -- council | housing_association | water | energy | supplier | other
  location      TEXT,                 -- e.g. council area / region, aids research
  complaints_email TEXT,
  complaints_url   TEXT,
  phone         TEXT,
  -- Researched / editable complaints-procedure profile:
  ombudsman_name           TEXT,      -- e.g. "Local Government & Social Care Ombudsman"
  ombudsman_url            TEXT,
  ombudsman_referral_months INTEGER,  -- window to refer to the ombudsman
  stage1_response_days     INTEGER,   -- working days for a Stage 1 response
  stage2_response_days     INTEGER,   -- working days for a Stage 2 response
  ack_days                 INTEGER,   -- working days to acknowledge
  procedure_summary        TEXT,      -- how their complaints process works
  legal_basis              TEXT,      -- the statutory framework that applies
  sources                  JSONB,     -- [{title,url}] researched references
  research_status          TEXT NOT NULL DEFAULT 'none', -- none | researched | manual
  researched_at            TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orgs_name ON organisations (lower(name));

CREATE TRIGGER trg_orgs_updated_at
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- complaints ------------------------------------------------------------
CREATE TABLE complaints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations (id) ON DELETE SET NULL,
  org_name      TEXT NOT NULL,        -- snapshot (organisation may be null/edited)
  org_type      TEXT NOT NULL DEFAULT 'council',
  reference     TEXT,                 -- their complaint reference
  our_reference TEXT,
  property      TEXT,                 -- which property/address it relates to
  subject       TEXT NOT NULL,
  category      TEXT,                 -- repairs | council_tax | billing | service | …
  description   TEXT,
  channel       TEXT DEFAULT 'email', -- email | phone | portal | letter | other
  raised_on     DATE NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'stage_1',
    -- stage_1 | stage_2 | ombudsman | resolved | closed
  state         TEXT NOT NULL DEFAULT 'open',   -- open | resolved | closed
  acknowledged_on DATE,
  responded_on    DATE,               -- response received for the current stage
  response_due    DATE,               -- auto-computed; editable
  ombudsman_deadline DATE,            -- auto-computed referral deadline
  outcome       TEXT,
  closed_on     DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_complaints_org ON complaints (organisation_id);
CREATE INDEX idx_complaints_state ON complaints (state);
CREATE INDEX idx_complaints_response_due ON complaints (response_due)
  WHERE state = 'open';

CREATE TRIGGER trg_complaints_updated_at
  BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- complaint_events (timeline / evidence) --------------------------------
CREATE TABLE complaint_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  UUID NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,
  event_date    DATE NOT NULL,
  type          TEXT NOT NULL DEFAULT 'note',
    -- raised | acknowledged | chased | response_received | escalated |
    -- resolved | deadline_missed | note
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_complaint_events_complaint ON complaint_events (complaint_id, event_date);
