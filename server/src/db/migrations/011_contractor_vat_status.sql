-- ---------------------------------------------------------------------------
-- 011: Whether the contractor is VAT registered, and what that means for the
--      commission they collected.
--
-- VAT-registered contractor: their whole invoice carries VAT, so the VAT on our
--   commission came with it. They invoice £99 + VAT, collect £9 of commission
--   plus £1.80 of VAT on it, and we invoice £9 + £1.80 = £10.80. Easy.
--
-- NOT VAT registered: they can't charge VAT, so they invoice £99 flat and only
--   ever collect £9. Greenco is VAT registered and must charge VAT on its own
--   supply, so that £9 is treated as the VAT-INCLUSIVE total: we invoice
--   £7.50 + £1.50 VAT = £9.00. The contractor pays back exactly what they
--   collected and isn't left out of pocket; Greenco accounts for the VAT out
--   of it.
--
-- The status is snapshotted onto each logged invoice, so a contractor
-- registering for VAT later never re-rates commission already collected.
-- ---------------------------------------------------------------------------

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS vat_registered BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE contractor_invoices
  ADD COLUMN IF NOT EXISTS commission_vat_inclusive BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN contractor_invoices.commission_vat_inclusive IS
  'True when commission_amount is the VAT-inclusive total the contractor collected (they are not VAT registered), so it is netted down when we invoice it back.';
