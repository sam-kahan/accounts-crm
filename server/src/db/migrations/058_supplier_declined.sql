-- Organisations Greenco has said not to raise the complaint with ("Not
-- needed" on the page's suggestion): never suggested again for this complaint.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS supplier_declined TEXT[] NOT NULL DEFAULT '{}';
