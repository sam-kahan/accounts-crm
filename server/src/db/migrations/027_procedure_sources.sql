-- ---------------------------------------------------------------------------
-- 027: where each figure of an organisation's procedure came from
--
-- procedure_sources maps a column (ack_days, stage1_response_days, ...) to
-- 'document' (their procedure document), 'research' (their website) or
-- 'entered' (typed in). Reading a procedure document used to replace every
-- figure, wiping the researched ones the document didn't mention; now the
-- document's figures win, the rest are kept from research (and researched if
-- missing), and each figure says where it came from.
-- ---------------------------------------------------------------------------

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS procedure_sources JSONB;
