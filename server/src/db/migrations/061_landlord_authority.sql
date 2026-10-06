-- ---------------------------------------------------------------------------
-- 061: The landlord's authority (services/authority.js).
--
-- An organisation that says Greenco isn't authorised on the account won't
-- deal with it until it has the landlord's authority. The system finds one
-- already on file and sends it; when there is none, Greenco asks the
-- landlord, from the complaint:
--   complaints.landlord_name / landlord_email  who to ask (typed once);
--   complaints.authority_done_on  "Already sorted" pressed: a request on or
--                                 before that day is settled;
--   complaint_outbox.to_landlord  the email asking the landlord: recorded as
--                                 landlord correspondence (removed_org =
--                                 'the landlord'), never contact with the
--                                 organisation.
-- ---------------------------------------------------------------------------

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS landlord_name TEXT,
  ADD COLUMN IF NOT EXISTS landlord_email TEXT,
  ADD COLUMN IF NOT EXISTS authority_done_on DATE;

ALTER TABLE complaint_outbox
  ADD COLUMN IF NOT EXISTS to_landlord BOOLEAN NOT NULL DEFAULT false;
