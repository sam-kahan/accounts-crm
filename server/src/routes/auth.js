import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { sendPasswordResetEmail } from '../services/mailer.js';

const router = Router();

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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
  asyncHandler(async (req, res) => {
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
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) throw new HttpError(401, 'Invalid email or password');

    clearAttempts(ip);
    // Guard against session fixation: issue a fresh session on login.
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      res.json({ id: user.id, email: user.email, name: user.name });
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
      try {
        await sendPasswordResetEmail({ to: user.email, link });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Password reset email failed:', err.message);
      }
      if (process.env.NODE_ENV !== 'production') devToken = token;
    }
    res.json({ ok: true, ...(devToken ? { devToken } : {}) });
  }),
);

// Complete a reset with a valid token.
router.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const { token, password } = parse(resetInput, req.body);
    const { rows } = await query(
      `SELECT * FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    const rec = rows[0];
    if (!rec) throw new HttpError(400, 'This reset link is invalid or has expired.');

    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      rec.user_id,
      hash,
    ]);
    await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [
      rec.id,
    ]);
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
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      hash,
    ]);
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.session?.userId) throw new HttpError(401, 'Not authenticated');
    const { rows } = await query(
      'SELECT id, email, name FROM users WHERE id = $1',
      [req.session.userId],
    );
    if (!rows[0]) {
      req.session.destroy(() => {});
      throw new HttpError(401, 'Not authenticated');
    }
    res.json(rows[0]);
  }),
);

export default router;
