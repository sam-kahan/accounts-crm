-- ---------------------------------------------------------------------------
-- 001_init: companies, key dates, tasks
-- The first module of the Greenco Accounts CRM: track limited companies and
-- their statutory key dates + ad-hoc tasks.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() is a core function since PostgreSQL 13, so no extension is
-- needed — this keeps the app's DB user free of any superuser requirement.

-- Shared trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --- companies -------------------------------------------------------------
CREATE TABLE companies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  company_number   TEXT UNIQUE,                 -- Companies House number (8 chars)
  status           TEXT NOT NULL DEFAULT 'active', -- active | dormant | dissolved | other
  incorporation_date DATE,
  accounts_next_due  DATE,                       -- Companies House: accounts filing deadline
  confirmation_statement_next_due DATE,          -- Companies House: confirmation statement deadline
  registered_office TEXT,
  sic_codes        TEXT[],                       -- nature of business
  notes            TEXT,
  ch_last_synced_at TIMESTAMPTZ,                 -- last successful Companies House sync
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_companies_name ON companies (lower(name));

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- key_dates -------------------------------------------------------------
-- Statutory / important dates attached to a company.
CREATE TABLE key_dates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  category     TEXT NOT NULL DEFAULT 'custom',
    -- accounts | confirmation_statement | corporation_tax | vat | paye | custom
  title        TEXT NOT NULL,
  due_date     DATE NOT NULL,
  recurrence   TEXT NOT NULL DEFAULT 'none',  -- none | annual | quarterly | monthly
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | done
  source       TEXT NOT NULL DEFAULT 'manual',  -- manual | companies_house
  notes        TEXT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_key_dates_company ON key_dates (company_id);
CREATE INDEX idx_key_dates_due ON key_dates (due_date) WHERE status = 'pending';
-- One synced row per (company, category) for Companies-House-owned dates so
-- re-syncing updates in place rather than duplicating.
CREATE UNIQUE INDEX idx_key_dates_ch_unique
  ON key_dates (company_id, category)
  WHERE source = 'companies_house';

CREATE TRIGGER trg_key_dates_updated_at
  BEFORE UPDATE ON key_dates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- tasks -----------------------------------------------------------------
-- Ad-hoc to-dos, optionally linked to a company.
CREATE TABLE tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID REFERENCES companies (id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  due_date     DATE,
  priority     TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  status       TEXT NOT NULL DEFAULT 'todo',   -- todo | in_progress | done
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_company ON tasks (company_id);
CREATE INDEX idx_tasks_status_due ON tasks (status, due_date);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
