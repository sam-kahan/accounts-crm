-- Whether an account may be deleted rests on how it began and whether it was
-- ever taken up, not on invited_at, which every resent link used to refresh:
-- sending a password link to an account in use made it look like an unused
-- invitation, and deletable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_invite BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;

-- Accounts created and invited in the same moment were created by invitation;
-- one invited long after it was made was an existing account sent a link.
UPDATE users SET created_by_invite = true
 WHERE invited_at IS NOT NULL AND invited_at <= created_at + interval '5 minutes';

-- A link already used means the person set their own password.
UPDATE users u SET password_set_at = t.used_at
  FROM (SELECT user_id, max(used_at) AS used_at FROM password_reset_tokens
         WHERE used_at IS NOT NULL GROUP BY user_id) t
 WHERE t.user_id = u.id AND u.password_set_at IS NULL;
