-- A contractor's usual office.
--
-- The site address decides which Greenco company raises the commission, and
-- when the address can't be placed the form asks — two separate legal entities
-- means a guess is an accounting problem, not a typo. But plenty of
-- contractors only ever work one city, and their invoices are exactly the ones
-- that arrive with a half address on them ("the flat above the shop"), so the
-- form ends up asking a question whose answer never changes.
--
-- This is that answer, kept once per contractor. It is a FALLBACK, never an
-- override: a postcode on the invoice still decides, so a Liverpool
-- contractor's Manchester job is still Manchester. NULL keeps today's
-- behaviour of asking.
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS default_region TEXT;

ALTER TABLE contractors
  ADD CONSTRAINT contractors_default_region_check
  CHECK (default_region IS NULL OR default_region IN ('manchester', 'liverpool'));

COMMENT ON COLUMN contractors.default_region IS
  'Office to fall back to when the property address does not settle it. NULL = ask.';
