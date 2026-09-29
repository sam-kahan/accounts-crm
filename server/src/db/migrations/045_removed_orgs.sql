-- Organisations taken off a complaint (added by mistake, or the main one
-- replaced). Their emails and timeline entries stay on the complaint as
-- history, but they must never count as another organisation's
-- correspondence ("you wrote to them on …" holding back a chase), and a
-- later email from them must never be recorded on another organisation's
-- part. So:
--   complaints.removed_orgs  [{name, organisation_id, reference, domains,
--                             removed_on}] — to recognise their later emails;
--   removed_org on emails and timeline entries — whose history it is.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS removed_orgs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE complaint_emails ADD COLUMN IF NOT EXISTS removed_org TEXT;
ALTER TABLE complaint_events ADD COLUMN IF NOT EXISTS removed_org TEXT;

-- Organisations already taken off (before this was kept): known by name from
-- the timeline note the removal wrote. Their domains aren't known, so later
-- emails are recognised by the organisation the author writes for.
UPDATE complaints c SET removed_orgs = x.list
  FROM (
    SELECT complaint_id,
           jsonb_agg(DISTINCT jsonb_build_object(
             'name', substring(note FROM '^(.+?) taken off this complaint'),
             'organisation_id', NULL, 'reference', NULL, 'domains', '[]'::jsonb,
             'removed_on', event_date::text)) AS list
      FROM complaint_events
     WHERE type = 'note' AND note ~ '^.+? taken off this complaint'
     GROUP BY complaint_id
  ) x
 WHERE x.complaint_id = c.id;
