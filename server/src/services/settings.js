import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Settings changed from the app rather than the server's .env (which needs
// someone on the server to edit). Small JSON values keyed by name.
// ---------------------------------------------------------------------------

export async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value, by = null) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by],
  );
}

// The mailboxes the system watches: set in the app, or MS_WATCH_MAILBOXES as
// the server-side default. Lower-cased and de-duplicated.
export async function watchedMailboxes() {
  const saved = await getSetting('watch_mailboxes');
  const list = Array.isArray(saved?.mailboxes)
    ? saved.mailboxes
    : String(process.env.MS_WATCH_MAILBOXES || '').split(',');
  return [...new Set(list.map((m) => String(m).trim().toLowerCase()).filter(Boolean))];
}
