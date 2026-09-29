-- What a complaint was known by before a Tidy up merge, so nothing quoting
-- it goes astray:
--   merged_refs       our GC-C codes of the complaints merged into this one:
--                     their own addresses (complaint-<code>@) and the code in
--                     an email still file it here
--   other_references  their references that differed (the same organisation
--                     logged twice, as REF-111 and REF-222): matched and
--                     searched like the reference itself
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS merged_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS other_references TEXT[] NOT NULL DEFAULT '{}';
-- Merges already made say so on the kept complaint's timeline.
UPDATE complaints c SET merged_refs = sub.refs
  FROM (
    SELECT e.complaint_id, array_agg(DISTINCT m[1]) AS refs
      FROM complaint_events e, regexp_matches(e.note, '^Merged in (GC-C-[A-Z0-9]{6})') AS m
     GROUP BY e.complaint_id
  ) sub
 WHERE sub.complaint_id = c.id;
