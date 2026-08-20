-- ---------------------------------------------------------------------------
-- 012: One VAT rate, not one per contractor
--
-- The VAT on a commission invoice is Greenco's own VAT, charged because Greenco
-- is VAT registered — it has nothing to do with the contractor. Holding it per
-- contractor only created a way to get it wrong (a contractor left at 0% would
-- have had VAT quietly under-declared on every invoice raised to them).
--
-- It now comes from one setting, COMMISSION_VAT_RATE (default 20). Nothing is
-- lost: commission_invoices.vat_rate already snapshots the rate each raised
-- invoice actually used, so history stays intact.
--
-- Whether the CONTRACTOR is VAT registered is a different question and stays:
-- it decides whether the commission they collected is net or VAT-inclusive.
-- ---------------------------------------------------------------------------

ALTER TABLE contractors DROP COLUMN IF EXISTS commission_vat_rate;
