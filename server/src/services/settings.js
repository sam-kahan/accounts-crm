import { query } from '../db/pool.js';
import { config } from '../config.js';

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
  return [...new Set(list.map((m) => String(m).trim().toLowerCase()).filter((m) => m && mailboxAllowed(m)))];
}

// The mailboxes the system may ever read. The Graph connection can read any
// mailbox in the tenant, so a mailbox chosen in the app must be one of
// MS_ALLOWED_MAILBOXES when that is set, and otherwise on our own domain.
// Checked when one is chosen AND whenever the list is read, so a list saved
// before the rule (or edited in the database) can't reach past it.
export function allowedMailboxList() {
  return String(process.env.MS_ALLOWED_MAILBOXES || '').split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
}
export function mailboxAllowed(m) {
  const box = String(m || '').trim().toLowerCase();
  if (!box) return false;
  const list = allowedMailboxList();
  if (list.length) return list.includes(box);
  const domain = String(config.complaintEmail.domain || '').trim().toLowerCase();
  return Boolean(domain) && box.endsWith(`@${domain}`);
}
