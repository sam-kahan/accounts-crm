-- Referring a complaint to the ombudsman by email, from the complaint.
--   ombudsmen.refer_email       the address that takes a NEW complaint by
--                               email (their general address may only take
--                               correspondence on an existing case)
--   ombudsmen.refer_email_note  what they say about it (their form to fill
--                               in and attach, a size limit, …), with the
--                               source in `evidence` like every other figure
--   complaint_outbox.then_refer the email IS the referral: once it has gone
--                               that organisation's part moves to "with the
--                               ombudsman", dated the day it went
--   complaint_outbox.attach_evidence  the complaint's evidence goes with it
ALTER TABLE ombudsmen ADD COLUMN IF NOT EXISTS refer_email TEXT;
ALTER TABLE ombudsmen ADD COLUMN IF NOT EXISTS refer_email_note TEXT;
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS then_refer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS attach_evidence BOOLEAN NOT NULL DEFAULT false;
