-- A complaint logged here before it has been sent to the organisation.
-- Set only when a person says so (the Log form asks), never guessed from
-- what is on file: every complaint already on file was sent, and stays as it
-- is. While it is set, nothing is due from them; the page offers to draft and
-- send the complaint, and sending it (or recording it as sent from Outlook)
-- clears it and starts the complaint from that day.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS not_sent_yet BOOLEAN NOT NULL DEFAULT false;

-- The one complaint logged before this existed that has not been sent yet
-- (Liverpool City Council, summons costs, Apartment 319 2 Moorfields): only
-- while nothing has happened on it.
UPDATE complaints c SET not_sent_yet = true
 WHERE c.ref_code = 'GC-C-HTZNCU' AND c.state = 'open' AND c.stage = 'stage_1'
   AND c.acknowledged_on IS NULL AND c.responded_on IS NULL AND c.final_response_on IS NULL
   AND NOT EXISTS (SELECT 1 FROM complaint_events e WHERE e.complaint_id = c.id AND e.type = 'raised'
                   AND e.note LIKE 'Formal complaint made%');
