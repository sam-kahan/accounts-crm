import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';

const router = Router();

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
