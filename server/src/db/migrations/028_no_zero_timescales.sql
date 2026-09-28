-- ---------------------------------------------------------------------------
-- 028: a timescale of 0 is "not stated", not zero days
--
-- Research that found no figure returned an empty value that was rounded to 0,
-- and 0 was saved as if it were their timescale (0 days to acknowledge, 0 days
-- for Stage 1). None of these can really be 0, so every 0 becomes "not
-- stated", and the standard for that kind of organisation applies again, as
-- it did before. Where a 0 came with a note of where it came from, that note
-- goes too.
-- ---------------------------------------------------------------------------

UPDATE organisations SET
  ack_days = NULLIF(ack_days, 0),
  stage1_response_days = NULLIF(stage1_response_days, 0),
  stage2_response_days = NULLIF(stage2_response_days, 0),
  ombudsman_referral_months = NULLIF(ombudsman_referral_months, 0),
  ombudsman_after_weeks = NULLIF(ombudsman_after_weeks, 0),
  procedure_sources = CASE WHEN procedure_sources IS NULL THEN NULL ELSE
    procedure_sources
      - (CASE WHEN ack_days = 0 THEN 'ack_days' ELSE '' END)
      - (CASE WHEN stage1_response_days = 0 THEN 'stage1_response_days' ELSE '' END)
      - (CASE WHEN stage2_response_days = 0 THEN 'stage2_response_days' ELSE '' END)
      - (CASE WHEN ombudsman_referral_months = 0 THEN 'ombudsman_referral_months' ELSE '' END)
      - (CASE WHEN ombudsman_after_weeks = 0 THEN 'ombudsman_after_weeks' ELSE '' END)
  END
WHERE 0 IN (ack_days, stage1_response_days, stage2_response_days, ombudsman_referral_months, ombudsman_after_weeks);
