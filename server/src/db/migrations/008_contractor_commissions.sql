-- ---------------------------------------------------------------------------
-- 008: Contractor commission tracking
--
-- Some contractors agree to include a commission for Greenco inside the
-- invoices they send us (e.g. a £100 tap repair of which £10 is ours). We pay
-- the full invoice out of the CLIENT account — it is charged to the landlord's
-- statement — and then invoice the contractor at month end for the commission
-- they included. These three tables track that cycle:
--
--   contractors         — the trade supplier + the commission deal agreed
--                         with them (the default applied to their invoices)
--   commission_invoices — the monthly invoice WE raise TO a contractor
--   contractor_invoices — an invoice we received FROM a contractor, with the
--                         commission it carried; linked to the commission
--                         invoice once it has been billed
--
-- Money is NUMERIC(12,2) — exact decimal. The app computes in integer pence
-- (server/src/lib/money.js) so nothing ever rides on binary floating point.
-- ---------------------------------------------------------------------------

-- --- contractors -----------------------------------------------------------
CREATE TABLE contractors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  trade         TEXT,                  -- plumber | electrician | general | …
  contact_name  TEXT,
  email         TEXT,                  -- where the commission invoice is sent
  phone         TEXT,
  address       TEXT,
  -- The commission agreement, applied as the default to every invoice logged
  -- against this contractor (each invoice keeps its own snapshot, so changing
  -- the deal never rewrites history).
  commission_type     TEXT NOT NULL DEFAULT 'percentage',  -- percentage | fixed
  commission_rate     NUMERIC(6,3) NOT NULL DEFAULT 0,     -- percent, e.g. 10.000
  commission_fixed    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- flat £ per invoice
  commission_on       TEXT NOT NULL DEFAULT 'net',         -- net | gross (of VAT)
  commission_basis    TEXT NOT NULL DEFAULT 'inclusive',
    -- inclusive: the commission is already inside the invoice total (the usual
    --            deal — we pay £100, £10 of it is ours to reclaim)
    -- on_top:    the commission is charged in addition to the invoice value
  commission_vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,     -- VAT we add when invoicing them
  payment_terms_days  INTEGER NOT NULL DEFAULT 30,
  agreement_notes TEXT,               -- what was actually agreed, in words
  active        BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contractors_commission_type_chk CHECK (commission_type IN ('percentage', 'fixed')),
  CONSTRAINT contractors_commission_on_chk   CHECK (commission_on IN ('net', 'gross')),
  CONSTRAINT contractors_basis_chk           CHECK (commission_basis IN ('inclusive', 'on_top')),
  CONSTRAINT contractors_rate_chk            CHECK (commission_rate >= 0 AND commission_rate <= 100),
  CONSTRAINT contractors_fixed_chk           CHECK (commission_fixed >= 0),
  CONSTRAINT contractors_vat_chk             CHECK (commission_vat_rate >= 0 AND commission_vat_rate <= 100),
  CONSTRAINT contractors_terms_chk           CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365)
);

CREATE INDEX idx_contractors_name ON contractors (lower(name));

CREATE TRIGGER trg_contractors_updated_at
  BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- commission_invoices ---------------------------------------------------
-- The invoice we raise to the contractor for a period's commission. Its lines
-- are the contractor_invoices pointing at it.
CREATE SEQUENCE commission_invoice_number_seq;

CREATE TABLE commission_invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  UUID NOT NULL REFERENCES contractors (id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL UNIQUE,     -- e.g. GC-COM-00001
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  issue_date     DATE NOT NULL,
  due_date       DATE NOT NULL,
  net_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- sum of the commission lines
  vat_rate       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  vat_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft',      -- draft | sent | paid | void
  sent_at        TIMESTAMPTZ,
  sent_to        TEXT,
  paid_on        DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commission_invoices_status_chk CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  CONSTRAINT commission_invoices_period_chk CHECK (period_end >= period_start)
);

CREATE INDEX idx_commission_invoices_contractor
  ON commission_invoices (contractor_id, issue_date DESC);
CREATE INDEX idx_commission_invoices_status ON commission_invoices (status);

CREATE TRIGGER trg_commission_invoices_updated_at
  BEFORE UPDATE ON commission_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- contractor_invoices ---------------------------------------------------
-- An invoice received from a contractor that carried commission for us. The
-- uploaded document lives on disk; the row records where.
CREATE TABLE contractor_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id   UUID NOT NULL REFERENCES contractors (id) ON DELETE RESTRICT,
  invoice_number  TEXT,                 -- their invoice number
  invoice_date    DATE NOT NULL,
  property        TEXT,                 -- the property / job the work relates to
  landlord_ref    TEXT,                 -- statement or landlord reference it is charged to
  description     TEXT,                 -- what the work was
  net_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,   -- what we pay them
  -- Snapshot of the deal as it stood when this invoice was logged.
  commission_type   TEXT NOT NULL DEFAULT 'percentage',
  commission_rate   NUMERIC(6,3) NOT NULL DEFAULT 0,
  commission_on     TEXT NOT NULL DEFAULT 'net',
  commission_basis  TEXT NOT NULL DEFAULT 'inclusive',
  commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_override BOOLEAN NOT NULL DEFAULT false,  -- amount was hand-edited
  paid_from       TEXT NOT NULL DEFAULT 'client',      -- client | business account
  paid_on         DATE,
  waived          BOOLEAN NOT NULL DEFAULT false,      -- not being reclaimed
  waived_reason   TEXT,
  commission_invoice_id UUID REFERENCES commission_invoices (id) ON DELETE SET NULL,
  -- The uploaded invoice document (optional — a row can be keyed in by hand).
  filename        TEXT,
  mimetype        TEXT,
  size_bytes      INTEGER,
  storage_path    TEXT,
  extracted       BOOLEAN NOT NULL DEFAULT false,      -- fields came from AI extraction
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contractor_invoices_type_chk  CHECK (commission_type IN ('percentage', 'fixed')),
  CONSTRAINT contractor_invoices_on_chk    CHECK (commission_on IN ('net', 'gross')),
  CONSTRAINT contractor_invoices_basis_chk CHECK (commission_basis IN ('inclusive', 'on_top')),
  CONSTRAINT contractor_invoices_paid_from_chk CHECK (paid_from IN ('client', 'business')),
  CONSTRAINT contractor_invoices_amounts_chk
    CHECK (net_amount >= 0 AND vat_amount >= 0 AND total_amount >= 0 AND commission_amount >= 0),
  -- A waived commission is never billed, so it must not sit on an invoice.
  CONSTRAINT contractor_invoices_waived_chk
    CHECK (NOT (waived AND commission_invoice_id IS NOT NULL))
);

-- Stops the same contractor invoice being logged (and its commission claimed)
-- twice — the whole point of the module is that the totals are trustworthy.
CREATE UNIQUE INDEX uq_contractor_invoices_number
  ON contractor_invoices (contractor_id, lower(invoice_number))
  WHERE invoice_number IS NOT NULL;

CREATE INDEX idx_contractor_invoices_contractor
  ON contractor_invoices (contractor_id, invoice_date DESC);
CREATE INDEX idx_contractor_invoices_date ON contractor_invoices (invoice_date DESC);
-- The month-end question: "what is still to be billed?"
CREATE INDEX idx_contractor_invoices_pending
  ON contractor_invoices (contractor_id, invoice_date)
  WHERE commission_invoice_id IS NULL AND NOT waived;
CREATE INDEX idx_contractor_invoices_commission_invoice
  ON contractor_invoices (commission_invoice_id);

CREATE TRIGGER trg_contractor_invoices_updated_at
  BEFORE UPDATE ON contractor_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
