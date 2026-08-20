-- ---------------------------------------------------------------------------
-- 014: Which Greenco company the commission is invoiced from
--
-- Greenco works two cities from two limited companies — Greenco Group Limited
-- (Manchester) and Greenco Liverpool Limited (Liverpool) — and each raises its
-- own invoices from its own company in Greenco Invoicing. Which one bills a
-- job is decided by WHERE THE JOB WAS, read off the site address on the
-- contractor's invoice (services/regions.js), so it is a property of the
-- invoice and not of the contractor: the same plumber works both cities.
--
--   contractor_invoices.region   where this job was
--   commission_invoices.region   which company raised the invoice
--
-- A month end therefore produces one commission invoice per contractor PER
-- REGION: two legal entities cannot bill on one document.
--
-- Everything logged before today was invoiced from Greenco Group Limited, so
-- that is what the existing rows are backfilled to — it is what actually
-- happened, not a default standing in for the unknown.
-- ---------------------------------------------------------------------------

ALTER TABLE contractor_invoices
  ADD COLUMN IF NOT EXISTS region TEXT;

ALTER TABLE commission_invoices
  ADD COLUMN IF NOT EXISTS region TEXT,
  -- Which company in Greenco Invoicing this was actually pushed to, snapshotted
  -- so a re-pointed setting can never make history read as if it went elsewhere.
  ADD COLUMN IF NOT EXISTS external_company_id INTEGER;

UPDATE contractor_invoices SET region = 'manchester' WHERE region IS NULL;
UPDATE commission_invoices SET region = 'manchester' WHERE region IS NULL;

ALTER TABLE contractor_invoices ALTER COLUMN region SET NOT NULL;
ALTER TABLE contractor_invoices ALTER COLUMN region SET DEFAULT 'manchester';
ALTER TABLE commission_invoices ALTER COLUMN region SET NOT NULL;
ALTER TABLE commission_invoices ALTER COLUMN region SET DEFAULT 'manchester';

ALTER TABLE contractor_invoices DROP CONSTRAINT IF EXISTS contractor_invoices_region_chk;
ALTER TABLE contractor_invoices ADD CONSTRAINT contractor_invoices_region_chk
  CHECK (region IN ('manchester', 'liverpool'));

ALTER TABLE commission_invoices DROP CONSTRAINT IF EXISTS commission_invoices_region_chk;
ALTER TABLE commission_invoices ADD CONSTRAINT commission_invoices_region_chk
  CHECK (region IN ('manchester', 'liverpool'));

-- The month-end question is now asked per office: "what is Liverpool still to
-- invoice?" — so the pending index carries the region.
DROP INDEX IF EXISTS idx_contractor_invoices_pending;
CREATE INDEX idx_contractor_invoices_pending
  ON contractor_invoices (contractor_id, region, invoice_date)
  WHERE commission_invoice_id IS NULL AND NOT waived;
