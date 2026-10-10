import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse, phoneLine } from '../lib/http.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { describeAccess } from '../services/permissions.js';
import { sendPasswordResetEmail } from '../services/mailer.js';
import { buildSignature, signatureAssetPath } from '../lib/emailSignature.js';

const router = Router();

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// A hash of nothing anybody knows, compared against when no account matches.
const NO_ACCOUNT_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// --- very light brute-force throttle (per IP, in-memory) -------------------
const attempts = new Map(); // ip -> { count, first }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttle(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}
function clearAttempts(ip) {
  attempts.delete(ip);
}

router.post(
  '/login',
  asyncHandler(async (req, res, next) => {
    const ip = req.ip;
    if (throttle(ip)) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
    const { email, password } = parse(loginInput, req.body);
    const { rows } = await query(
      'SELECT * FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const user = rows[0];
    // A password is checked even when there is no such account, so the time
    // taken doesn't say which addresses have one (as Forgot password keeps).
    const ok = await bcrypt.compare(password, user?.password_hash || NO_ACCOUNT_HASH) && Boolean(user);
    if (!ok) throw new HttpError(401, 'Invalid email or password');
    if (user.active === false) {
      throw new HttpError(403, 'This account has been deactivated. Ask an administrator.');
    }

    clearAttempts(ip);
    // Guard against session fixation: issue a fresh session on login. Errors
    // here run in a callback after the async handler has already resolved, so
    // forward them to `next` — throwing would become an uncaught exception and
    // crash the process instead of returning a clean 500.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        // Records that the invitation was taken up, and stops an account that
        // has actually been used being deleted rather than deactivated.
        query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(
          (e) => console.error('last_login_at update failed:', e.message),
        );
        res.json({
          id: user.id,
          email: user.email,
          name: user.name,
          // The same as /me: the page signs drafts with these, and My
          // signature opens on them, straight after signing in.
          job_title: user.job_title,
          post_nominals: user.post_nominals,
          direct_line: user.direct_line,
          office_phone: user.office_phone,
          mobile: user.mobile,
          ...describeAccess(user),
        });
      });
    });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('accounts.sid');
      res.json({ ok: true });
    });
  }),
);

// --- password reset --------------------------------------------------------
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const forgotSeen = new Map(); // key -> { count, first }
function forgotLimited(key, max) {
  const now = Date.now();
  if (forgotSeen.size > 5000) {
    for (const [k, r] of forgotSeen) if (now - r.first > FORGOT_WINDOW_MS) forgotSeen.delete(k);
  }
  const rec = forgotSeen.get(key);
  if (!rec || now - rec.first > FORGOT_WINDOW_MS) {
    forgotSeen.set(key, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

const forgotInput = z.object({ email: z.string().email() });
const resetInput = z.object({
  token: z.string().min(10),
  password: z.string().min(8),
});

// Request a reset link. Always responds 200 (never reveals whether the address
// exists). In non-production the token is returned to ease testing.
router.post(
  '/forgot',
  asyncHandler(async (req, res) => {
    const { email } = parse(forgotInput, req.body);
    // At most a few a quarter-hour per address and per IP: a reset email
    // can't be used to flood someone's inbox or spend the mail quota.
    // Refused quietly (the same answer), so it says nothing about the address.
    if (forgotLimited(`ip:${req.ip}`, 10) || forgotLimited(`to:${email.toLowerCase()}`, 3)) {
      return res.json({ ok: true });
    }
    const { rows } = await query(
      'SELECT id, email FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const user = rows[0];
    let devToken;
    if (user) {
      const token = randomBytes(32).toString('hex');
      await query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, sha256(token)],
      );
      const link = `${config.appUrl}/reset?token=${token}`;
      // Not waited for: the answer takes the same time whether or not the
      // address has an account.
      sendPasswordResetEmail({ to: user.email, link }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Password reset email failed:', err.message);
      });
      if (process.env.NODE_ENV !== 'production') devToken = token;
    }
    res.json({ ok: true, ...(devToken ? { devToken } : {}) });
  }),
);

// A new password ends every other way in: other unused reset/invite links,
// and every other signed-in session (all of them after a reset, since whoever
// asked for it may not be the one signed in; all but this one on a change).
async function endOtherAccess(userId, keepSid = null) {
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await query(
    `DELETE FROM session WHERE sess->>'userId' = $1::text AND ($2::text IS NULL OR sid <> $2)`,
    [String(userId), keepSid],
  ).catch((err) => console.error('[auth] sessions not ended:', err.message));
}

// Complete a reset with a valid token.
router.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const { token, password } = parse(resetInput, req.body);
    // Claimed in one statement, so a link pressed twice at once can't be
    // used twice.
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(token)],
    );
    const rec = rows[0];
    if (!rec) throw new HttpError(400, 'This reset link is invalid or has expired.');

    await query('UPDATE users SET password_hash = $2, password_set_at = now() WHERE id = $1', [
      rec.user_id,
      hash,
    ]);
    await endOtherAccess(rec.user_id);
    res.json({ ok: true });
  }),
);

// Change password while logged in (requires the current password).
const changeInput = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { current_password, new_password } = parse(changeInput, req.body);
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    const user = rows[0];
    if (!user) throw new HttpError(401, 'Not authenticated');
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) throw new HttpError(400, 'Current password is incorrect.');

    const hash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash = $2, password_set_at = now() WHERE id = $1', [
      user.id,
      hash,
    ]);
    await endOtherAccess(user.id, req.sessionID);
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.session?.userId) throw new HttpError(401, 'Not authenticated');
    const { rows } = await query(
      'SELECT id, email, name, job_title, post_nominals, direct_line, office_phone, mobile, role, permissions, active FROM users WHERE id = $1',
      [req.session.userId],
    );
    const user = rows[0];
    if (!user) {
      req.session.destroy(() => {});
      throw new HttpError(401, 'Not authenticated');
    }
    if (!user.active) {
      req.session.destroy(() => {});
      throw new HttpError(403, 'This account has been deactivated.');
    }
    // The UI builds its menu from exactly what the server enforces.
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      job_title: user.job_title,
      post_nominals: user.post_nominals,
      direct_line: user.direct_line,
      office_phone: user.office_phone,
      mobile: user.mobile,
      ...describeAccess(user),
    });
  }),
);

// --- My signature: the details every email I send is signed with --------
// Each person sets their own; an administrator can also set them in Staff &
// access. Name and job title are here too, since the signature is where they
// are read. Blank clears a line.
const signatureInput = z.object({
  name: z.string().max(200).optional().nullable(),
  job_title: z.string().max(200).optional().nullable(),
  post_nominals: z.string().max(60).optional().nullable(),
  direct_line: phoneLine,
  office_phone: phoneLine,
  mobile: phoneLine,
});
const tidy = (v) => (v === undefined ? undefined : (String(v ?? '').replace(/\s+/g, ' ').trim() || null));

router.put(
  '/me/signature',
  requireAuth,
  asyncHandler(async (req, res) => {
    const d = parse(signatureInput, req.body);
    const fields = ['name', 'job_title', 'post_nominals', 'direct_line', 'office_phone', 'mobile']
      .filter((k) => d[k] !== undefined);
    if (!fields.length) throw new HttpError(400, 'Nothing to update');
    const { rows } = await query(
      `UPDATE users SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1
       RETURNING name, email, job_title, post_nominals, direct_line, office_phone, mobile`,
      [req.user.id, ...fields.map((k) => tidy(d[k]))],
    );
    res.json(rows[0]);
  }),
);

// What my signature looks like (the pictures by URL, below, rather than
// inside an email). Takes the form's values, so the preview follows typing.
router.post(
  '/me/signature/preview',
  requireAuth,
  asyncHandler(async (req, res) => {
    const d = parse(signatureInput, req.body);
    const user = { ...req.user };
    for (const k of Object.keys(d)) if (d[k] !== undefined) user[k] = tidy(d[k]);
    const sig = buildSignature(user, {
      links: config.signature.links,
      imageSrc: (n) => `/api/auth/signature-asset/${n === 'banner' ? 'banner.jpg' : `${n}.png`}`,
    });
    res.json({ html: sig.html, text: sig.text, enabled: config.signature.enabled });
  }),
);

router.get(
  '/signature-asset/:file',
  requireAuth,
  (req, res) => {
    const file = signatureAssetPath(req.params.file);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  },
);

export default router;
