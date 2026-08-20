-- ---------------------------------------------------------------------------
-- 009: Link a commission invoice to its counterpart in Greenco Invoicing
--
-- A commission invoice raised here is pushed to invoices.greenco.co.uk so it
-- joins the normal invoicing flow — PDF, email, statements, the overdue sweep
-- and chasing. That system assigns the number the contractor actually sees;
-- our GC-COM-xxxxx rides along as its header reference so the two reconcile.
--
-- external_error keeps the last failure rather than losing it, so a push that
-- didn't land is visible and can be retried instead of quietly not existing.
-- ---------------------------------------------------------------------------

ALTER TABLE commission_invoices
  ADD COLUMN IF NOT EXISTS external_id        TEXT,
  ADD COLUMN IF NOT EXISTS external_number    TEXT,
  ADD COLUMN IF NOT EXISTS external_url       TEXT,
  ADD COLUMN IF NOT EXISTS external_status    TEXT,
  ADD COLUMN IF NOT EXISTS external_total     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS external_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_error     TEXT;

-- "Which invoices haven't reached the invoicing system yet?"
CREATE INDEX IF NOT EXISTS idx_commission_invoices_unpushed
  ON commission_invoices (issue_date DESC)
  WHERE external_id IS NULL AND status <> 'void';
