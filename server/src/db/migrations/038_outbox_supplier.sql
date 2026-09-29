-- "Raise it with the supplier" sends in the background too. The supplier is
-- added to the complaint once the email has gone (never if it fails), from
-- what is kept here: organisation_id, org_name, org_type.
ALTER TABLE complaint_outbox ADD COLUMN IF NOT EXISTS then_supplier JSONB;
