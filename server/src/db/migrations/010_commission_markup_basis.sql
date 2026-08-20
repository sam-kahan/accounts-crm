-- ---------------------------------------------------------------------------
-- 010: A commission that is a MARK-UP on the contractor's own price
--
-- How the agreements actually work: the contractor wants £90 for the job, adds
-- the agreed 10%, and invoices us £99 — £9 of which is ours to reclaim. The
-- percentage is therefore a mark-up on THEIR price, not a slice of the invoice
-- total (10% of £99 would be £9.90, and we would be over-claiming on every
-- job). The maths is net x rate / (100 + rate).
--
-- The two existing bases stay for agreements that really are worded the other
-- way round:
--   markup    — their price + X%, already inside the invoice   (the usual deal)
--   inclusive — X% of the invoice total, already inside it
--   on_top    — X%, charged in addition to their invoice
-- ---------------------------------------------------------------------------

ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_basis_chk;
ALTER TABLE contractors ADD CONSTRAINT contractors_basis_chk
  CHECK (commission_basis IN ('markup', 'inclusive', 'on_top'));
ALTER TABLE contractors ALTER COLUMN commission_basis SET DEFAULT 'markup';

ALTER TABLE contractor_invoices DROP CONSTRAINT IF EXISTS contractor_invoices_basis_chk;
ALTER TABLE contractor_invoices ADD CONSTRAINT contractor_invoices_basis_chk
  CHECK (commission_basis IN ('markup', 'inclusive', 'on_top'));
ALTER TABLE contractor_invoices ALTER COLUMN commission_basis SET DEFAULT 'markup';
