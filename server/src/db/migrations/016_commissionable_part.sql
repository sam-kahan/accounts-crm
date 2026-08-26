-- Commission on part of an invoice only.
--
-- Some invoices carry the commission on only part of what they bill: materials
-- passed on at cost, a skip or a permit paid for on our behalf, a job where
-- only the labour was marked up. The agreed rate then applies to that part, not
-- to the invoice — and typing the resulting figure in by hand loses the reason,
-- so a month-end total can no longer be explained and amending the invoice
-- can't re-cost it.
--
-- NULL means the whole invoice, which is what every row logged so far is, so
-- nothing needs backfilling and nothing is re-costed.
ALTER TABLE contractor_invoices
  ADD COLUMN commissionable_amount numeric(12,2),
  ADD COLUMN commissionable_note   text;

COMMENT ON COLUMN contractor_invoices.commissionable_amount IS
  'The part of the invoice the commission applies to, in the same measure as commission_on (net or gross). NULL = the whole invoice.';
