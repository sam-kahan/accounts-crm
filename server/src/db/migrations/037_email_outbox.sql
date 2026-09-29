-- Emails sent from a complaint go out in the background: the page doesn't
-- wait on the mail server. Each is queued here, sent, then recorded on the
-- complaint (and the complaint escalated when it was the Stage 2 request).
-- One that fails stays here, shown on the complaint with Try again / Discard.
--   pending  queued, not started      sending  handed to the mail server
--   sent     done                     failed   see error
CREATE TABLE IF NOT EXISTS complaint_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  UUID NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,
  party_id      UUID REFERENCES complaint_parties (id) ON DELETE SET NULL,
  to_addresses  TEXT[] NOT NULL,
  cc_addresses  TEXT[] NOT NULL DEFAULT '{}',
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  then_escalate BOOLEAN NOT NULL DEFAULT false,
  sent_by       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_complaint_outbox_open ON complaint_outbox (complaint_id) WHERE status <> 'sent';
