-- Migration 050 wrote the email addresses that take a new complaint, found by
-- research that could not open the pages themselves, into records a person
-- may already have ticked as checked. A tick given before those addresses
-- were there did not check them, and the referral (with all the evidence)
-- is only sent to a scheme whose record is checked: so those ticks are
-- cleared, to be given again once the address is confirmed on their site.
UPDATE ombudsmen
   SET verified_at = NULL, verified_by = NULL, updated_at = now()
 WHERE refer_email IS NOT NULL
   AND verified_at IS NOT NULL
   AND verified_at < COALESCE((SELECT applied_at FROM schema_migrations WHERE name = '050_ombudsman_email_referrals.sql'), now());
