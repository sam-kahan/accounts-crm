-- A doubt about the complaint itself, found by reading its emails (the
-- re-check): {kind: 'not_complaint' | 'raised_date', why, quote, date, at}.
-- 'not_complaint': no email shows a formal complaint being made (it may have
-- been imported from a query or a disputed bill). 'raised_date': the emails
-- show it was made on a different day from the one recorded, and every
-- deadline and the ombudsman date are worked out from that day. Shown on the
-- complaint until a person answers it; while it stands, the system never
-- says the complaint can go to the ombudsman.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complaint_doubt JSONB;
