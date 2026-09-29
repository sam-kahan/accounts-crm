-- An email may have gone even though it is marked failed (the server
-- restarted mid-send): `uncertain` offers "It went — record it" beside Try
-- again, so it is neither sent twice nor left unrecorded. `to_party` keeps
-- that the email was to a further organisation even if that organisation is
-- later taken off the complaint (party_id is then cleared), so it can never
-- escalate the main organisation's part instead.
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS uncertain BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS to_party BOOLEAN NOT NULL DEFAULT false;
UPDATE complaint_outbox SET to_party = true WHERE party_id IS NOT NULL;
UPDATE complaint_outbox SET uncertain = true WHERE status = 'failed' AND error LIKE 'The system restarted%';
