import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

// ---------------------------------------------------------------------------
// TRUST MODEL: this CRM is single-tenant by design — every logged-in user is a
// member of the Greenco accounts team and may legitimately see and edit every
// company, complaint, task and attachment. There is deliberately no per-user
// ownership/row scoping; `requireAuth` (a valid login session) is the only
// authorization boundary. If the app ever gains external or role-limited users,
// per-record ownership checks must be added to every data route.
// ---------------------------------------------------------------------------

// Gate a route/router behind a valid login session.
export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// Constant-time string comparison (avoids leaking the secret via timing).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Allow either a logged-in session or a matching cron key, for the unattended
// jobs (reminder digest, mailbox fetch). The key is read from the X-Cron-Key
// header (preferred) or ?key=/body.key (legacy — discouraged, as query strings
// land in access logs). Compared in constant time.
export function sessionOrCronKey(req, _res, next) {
  if (req.session?.userId) return next();
  const provided = req.get('x-cron-key') || req.query.key || req.body?.key;
  if (config.reminderCronKey && provided && safeEqual(provided, config.reminderCronKey)) {
    return next();
  }
  return next(new HttpError(401, 'Not authenticated'));
}
