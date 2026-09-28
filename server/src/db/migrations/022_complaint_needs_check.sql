-- ---------------------------------------------------------------------------
-- 022: Automatic, but checked
--
-- A complaint the system created by itself — imported from past emails, or
-- started from one of our emails — is marked needs_check until a person has
-- looked it over and pressed "Looks right". Automation fills the records in;
-- a person confirms them once.
-- ---------------------------------------------------------------------------

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS needs_check BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checked_by TEXT;

-- Complaints already imported or created from emails before this existed.
UPDATE complaints c SET needs_check = true
 WHERE c.checked_at IS NULL AND (
   EXISTS (SELECT 1 FROM complaint_events e WHERE e.complaint_id = c.id
            AND e.type = 'raised' AND (e.created_by LIKE 'Automatic%' OR e.note LIKE 'Imported from past emails%'))
 );
