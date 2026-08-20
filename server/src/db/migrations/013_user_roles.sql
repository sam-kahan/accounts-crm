-- ---------------------------------------------------------------------------
-- 013: Staff accounts with roles and per-section access
--
-- Until now every logged-in user could see and do everything — the trust model
-- was "one accounts team, one level of access". Adding the rest of the
-- department means that stops being true: some people should see the commission
-- figures without being able to raise invoices, some should never see it at all.
--
--   role        admin | staff | readonly. 'admin' always has full access to
--               everything including user management, so an admin can never
--               lock themselves out of the page that would fix it.
--   permissions {section: 'none'|'view'|'edit'} for staff and readonly. The
--               role sets the sensible starting point; this is what is actually
--               enforced, on the server, on every request.
--   active      a leaver is deactivated, not deleted — their logged work,
--               complaints and invoices stay attributable.
--
-- EXISTING USERS BECOME ADMINS (the column default), because they are the
-- accounts team who have been running this system on full access all along.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role          TEXT NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS permissions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS job_title     TEXT,
  ADD COLUMN IF NOT EXISTS invited_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE users ADD CONSTRAINT users_role_chk
  CHECK (role IN ('admin', 'staff', 'readonly'));

-- Every authenticated request loads the user to check what they may do, so the
-- lookup by id is the hot path (already the primary key) and the active filter
-- rides along with it.
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
