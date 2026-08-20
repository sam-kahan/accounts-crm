import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { query } from '../db/pool.js';
import { can, levelForMethod } from '../services/permissions.js';

// ---------------------------------------------------------------------------
// TRUST MODEL: everyone with a login is a member of the Greenco accounts
// department, so records are not owned by individuals — there is no per-row
// scoping, and anyone who can reach a section sees all of it. What varies is
// WHICH SECTIONS they can reach and whether they may change anything there
// (services/permissions.js).
//
// That check lives here, on the way in, rather than in each route: it is
// applied once per router in index.js and derives what is needed from the HTTP
// method, so a route added later is covered without anybody remembering to.
// The UI hides what it must, but the UI is not the boundary — this is.
// ---------------------------------------------------------------------------

// Gate a route/router behind a valid login session, and load the user so the
// permission checks (and the routes) know who is asking. One primary-key lookup
// per request, deliberately not cached: revoking someone's access has to take
// effect now, not when their session happens to expire.
export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  query(
    'SELECT id, email, name, role, permissions, active FROM users WHERE id = $1',
    [req.session.userId],
  )
    .then(({ rows }) => {
      const user = rows[0];
      if (!user) {
        // Deleted out from under a live session.
        return req.session.destroy(() =>
          res.status(401).json({ error: 'Not authenticated' }),
        );
      }
      if (!user.active) {
        return req.session.destroy(() =>
          res.status(403).json({ error: 'This account has been deactivated.' }),
        );
      }
      req.user = user;
      return next();
    })
    .catch(next);
}

// Require access to a section. `view` is enough for a GET; anything that could
// change data needs `edit`.
export function requirePermission(section) {
  return (req, _res, next) => {
    // The unattended jobs authenticate with the cron key and have no user;
    // they are trusted by the key itself.
    if (req.viaCronKey) return next();
    const needed = levelForMethod(req.method);
    if (can(req.user, section, needed)) return next();
    return next(
      new HttpError(
        403,
        needed === 'edit'
          ? 'You have read-only access to this part of the system.'
          : 'You don’t have access to this part of the system.',
      ),
    );
  };
}

// Shorthand for the pages only administrators should reach.
export const requireAdmin = requirePermission('admin');

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
export function sessionOrCronKey(req, res, next) {
  if (req.session?.userId) return requireAuth(req, res, next);
  const provided = req.get('x-cron-key') || req.query.key || req.body?.key;
  if (config.reminderCronKey && provided && safeEqual(provided, config.reminderCronKey)) {
    // Mark it so the permission checks let it through: there is no user behind
    // a cron run, and the key is the authorisation.
    req.viaCronKey = true;
    return next();
  }
  return next(new HttpError(401, 'Not authenticated'));
}
