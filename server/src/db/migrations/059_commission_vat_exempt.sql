-- ---------------------------------------------------------------------------
-- 059: Commission that is exempt from VAT (an insurance broker's).
--
-- Greenco is VAT registered, so commission is normally invoiced with VAT on
-- top (or netted out of what an unregistered contractor collected). Commission
-- for arranging insurance is different: insurance intermediation is an EXEMPT
-- supply (VAT Act 1994, Schedule 9, Group 2), so no VAT is charged on it at
-- all. The commission collected is invoiced back as it is, at 0%.
--
-- Set on the contractor, and snapshotted onto each logged invoice like the
-- rest of the deal, so the month end reads the treatment off the line itself.
-- ---------------------------------------------------------------------------

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS commission_vat_exempt BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE contractor_invoices
  ADD COLUMN IF NOT EXISTS commission_vat_exempt BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN contractor_invoices.commission_vat_exempt IS
  'True when the commission is an exempt supply (insurance intermediation): invoiced back with no VAT, and never netted down.';
