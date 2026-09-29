-- A complaint logged but not yet sent has no deadlines (nothing is due from
-- them until it goes); ones logged before recomputeDeadlines knew that had
-- dates worked out from the day they were logged, which later read as missed.
UPDATE complaints SET response_due = NULL, ombudsman_deadline = NULL
 WHERE not_sent_yet AND state = 'open' AND stage = 'stage_1'
   AND acknowledged_on IS NULL AND responded_on IS NULL AND final_response_on IS NULL;
