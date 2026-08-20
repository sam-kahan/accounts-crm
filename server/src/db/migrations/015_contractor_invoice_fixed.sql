-- ---------------------------------------------------------------------------
-- 015: The fixed fee belongs in the snapshot too
--
-- A logged invoice snapshots the deal it was costed under, so renegotiating a
-- rate never rewrites what was already billed. Every part of the agreement was
-- copied onto the row EXCEPT the flat fee: a contractor on "£15 a job" had the
-- 15 read from the contractor record each time.
--
-- On its own that was only a loose end, because nothing re-costed a logged
-- invoice. Editing one does, and dealFor() reading a column that isn't there
-- would have returned a fee of zero — quietly wiping the commission on every
-- fixed-fee invoice anyone amended.
--
-- Existing rows are backfilled from the contractor's current fee, and only
-- where the invoice was actually costed as a fixed fee. That is the best record
-- of the agreement that exists; a percentage invoice keeps 0, which is what its
-- fee has always been.
-- ---------------------------------------------------------------------------

ALTER TABLE contractor_invoices
  ADD COLUMN IF NOT EXISTS commission_fixed NUMERIC(12,2) NOT NULL DEFAULT 0;

UPDATE contractor_invoices i
   SET commission_fixed = c.commission_fixed
  FROM contractors c
 WHERE c.id = i.contractor_id
   AND i.commission_type = 'fixed'
   AND i.commission_fixed = 0;

ALTER TABLE contractor_invoices DROP CONSTRAINT IF EXISTS contractor_invoices_fixed_chk;
ALTER TABLE contractor_invoices ADD CONSTRAINT contractor_invoices_fixed_chk
  CHECK (commission_fixed >= 0);
