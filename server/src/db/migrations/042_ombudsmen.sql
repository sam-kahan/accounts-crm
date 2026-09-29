-- The ombudsman register: one record per scheme (the Energy Ombudsman, the
-- Housing Ombudsman, …) saying how and when a case can be taken to it, each
-- figure with the source it came from, and who checked it. The rules engine
-- reads WHEN a complaint can go and the time limit from here (not from code),
-- and nothing counts as able to go to a scheme until a person has checked
-- its record ("Complaints → Ombudsmen"). The values are seeded by migration
-- 043 from research of each scheme's official website, marked not checked.
CREATE TABLE IF NOT EXISTS ombudsmen (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT NOT NULL UNIQUE,      -- stable id, e.g. 'energy_ombudsman'
  name                  TEXT NOT NULL,
  website               TEXT,
  refer_url             TEXT,                      -- where a case is made (their online form)
  phone                 TEXT,
  email                 TEXT,
  post                  TEXT,
  -- When it will take a case (complaintRules.js#referralOpen):
  wait_weeks            INTEGER CHECK (wait_weeks IS NULL OR wait_weeks > 0),  -- after N weeks from the complaint, no final response needed
  after_final_response  BOOLEAN NOT NULL DEFAULT true,   -- once their final response / deadlock letter has come
  after_missed_deadline BOOLEAN NOT NULL DEFAULT false,  -- once they missed their last deadline (their procedure has run out)
  -- The time limit for taking it there, and what it counts from:
  time_limit_months     INTEGER CHECK (time_limit_months IS NULL OR time_limit_months > 0),
  time_limit_from       TEXT CHECK (time_limit_from IN ('final_response', 'raised')),
  who_can_complain      TEXT,                      -- eligibility (households, small businesses, …)
  representative        TEXT,                      -- whether an agent (Greenco) can complain for someone, and the authority needed
  what_to_include       TEXT[] NOT NULL DEFAULT '{}',
  notes                 TEXT,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {field: {text, url}}: the source for each figure
  verified_at           TIMESTAMPTZ,
  verified_by           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The scheme an organisation belongs to, when it isn't the usual one for its
-- type (a managing agent is TPO or PRS: it has to be chosen).
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ombudsman_id UUID REFERENCES ombudsmen(id) ON DELETE SET NULL;
