-- ---------------------------------------------------------------------------
-- 002: authentication (users + session store) and the financial year-end date
-- ---------------------------------------------------------------------------

-- Financial year end = the accounting period end date from Companies House
-- (accounts.next_made_up_to). Distinct from the accounts *filing* deadline.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS accounts_next_made_up_to DATE;

-- --- users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- session store (connect-pg-simple) -------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default",
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
