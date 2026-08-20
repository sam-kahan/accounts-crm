import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { buildUpdateSet } from '../lib/sql.js';
import {
  ROLES,
  LEVELS,
  SECTIONS,
  SECTION_KEYS,
  ROLE_DEFAULTS,
  ROLE_LABEL,
  ROLE_DESCRIPTION,
  normalisePermissions,
  effectivePermissions,
} from '../services/permissions.js';
import { sendInviteEmail, mailerStatus } from '../services/mailer.js';

// ---------------------------------------------------------------------------
// Staff accounts. Administrators only — the router is mounted behind
// requirePermission('admin') in index.js.
//
// Nobody is given a password by anybody: a new person is emailed a link and
// sets their own. That means a password is never typed into this screen, read
// out over a desk, or left in a chat message.
// ---------------------------------------------------------------------------

const router = Router();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const COLS = `id, email, name, job_title, role, permissions, active,
  invited_at, last_login_at, created_at, updated_at`;

const permissionsInput = z.record(z.enum(SECTION_KEYS), z.enum(LEVELS)).optional();

const createInput = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  job_title: z.string().max(200).optional().nullable(),
  role: z.enum(ROLES).optional(),
  permissions: permissionsInput,
});

const updateInput = z.object({
  name: z.string().min(1).max(200).optional(),
  job_title: z.string().max(200).optional().nullable(),
  role: z.enum(ROLES).optional(),
  permissions: permissionsInput,
  active: z.boolean().optional(),
});

function decorate(row) {
  if (!row) return row;
  return { ...row, effective_permissions: effectivePermissions(row) };
}

// Send someone a link to set their own password. Best-effort: a mail hiccup
// must not lose the account that was just created, so the caller is told what
// happened and can send it again.
async function issueInvite(user, invitedByName) {
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`,
    [user.id, sha256(token)],
  );
  await query('UPDATE users SET invited_at = now() WHERE id = $1', [user.id]);

  const link = `${config.appUrl}/reset?token=${token}`;
  try {
    const result = await sendInviteEmail({
      to: user.email,
      name: user.name,
      link,
      invitedBy: invitedByName,
    });
    return {
      sent: result.sent,
      reason: result.reason || null,
      // Without email configured the link has to reach them somehow; it is only
      // ever shown to the administrator who just created the account.
      link: result.sent ? undefined : link,
    };
  } catch (err) {
    return { sent: false, reason: err.message, link };
  }
}

// The vocabulary the form is built from — roles, sections and what each means —
// so the screen and the server can never describe access differently.
router.get(
  '/access/options',
  asyncHandler(async (_req, res) => {
    res.json({
      roles: ROLES.map((key) => ({
        key,
        label: ROLE_LABEL[key],
        description: ROLE_DESCRIPTION[key],
        defaults: ROLE_DEFAULTS[key],
      })),
      sections: SECTIONS,
      levels: LEVELS,
      mailer: mailerStatus(),
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(`SELECT ${COLS} FROM users ORDER BY active DESC, name, email`);
    res.json(rows.map(decorate));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(createInput, req.body);
    const email = d.email.trim().toLowerCase();
    const role = d.role || 'staff';

    const { rows: existing } = await query(
      'SELECT id, active FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    if (existing[0]) {
      throw new HttpError(
        409,
        existing[0].active
          ? 'Someone with that email address already has an account.'
          : 'That email address belongs to a deactivated account — reactivate it instead.',
      );
    }

    // A random password nobody knows, including us: the account can only be
    // opened through the emailed link, which sets a real one.
    const placeholder = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const { rows } = await query(
      `INSERT INTO users (email, name, job_title, password_hash, role, permissions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING ${COLS}`,
      [
        email,
        d.name.trim(),
        d.job_title?.trim() || null,
        placeholder,
        role,
        JSON.stringify(normalisePermissions(d.permissions, role)),
      ],
    );

    const invite = await issueInvite(rows[0], req.user?.name || req.user?.email);
    res.status(201).json({ ...decorate(rows[0]), invite });
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(updateInput, req.body);
    const { rows: current } = await query(`SELECT ${COLS} FROM users WHERE id = $1`, [
      req.params.id,
    ]);
    const user = current[0];
    if (!user) throw new HttpError(404, 'User not found');

    const isSelf = req.user?.id === user.id;
    // Two ways an administrator could lock themselves — or everyone — out.
    if (isSelf && d.active === false) {
      throw new HttpError(400, 'You can’t deactivate your own account.');
    }
    if (isSelf && d.role && d.role !== 'admin') {
      throw new HttpError(
        400,
        'You can’t remove your own administrator access — ask another administrator to.',
      );
    }
    if (user.role === 'admin' && (d.role && d.role !== 'admin' || d.active === false)) {
      const { rows: admins } = await query(
        "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1",
        [user.id],
      );
      if (admins[0].n === 0) {
        throw new HttpError(
          400,
          'This is the last administrator — promote someone else first, or nobody could manage access.',
        );
      }
    }

    const role = d.role || user.role;
    const { clause, values } = buildUpdateSet({
      name: d.name?.trim(),
      job_title: d.job_title === null ? null : d.job_title?.trim(),
      role: d.role,
      permissions:
        d.permissions || d.role
          ? JSON.stringify(normalisePermissions(d.permissions ?? user.permissions, role))
          : undefined,
      active: d.active,
    });
    if (!clause) throw new HttpError(400, 'Nothing to update');

    const { rows } = await query(
      `UPDATE users SET ${clause} WHERE id = $1 RETURNING ${COLS}`,
      [req.params.id, ...values],
    );
    res.json(decorate(rows[0]));
  }),
);

// Send the invitation again — the link expires, and email goes astray.
router.post(
  '/:id/invite',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT ${COLS} FROM users WHERE id = $1`, [req.params.id]);
    const user = rows[0];
    if (!user) throw new HttpError(404, 'User not found');
    if (!user.active) throw new HttpError(400, 'That account is deactivated.');
    const invite = await issueInvite(user, req.user?.name || req.user?.email);
    res.json({ ...decorate(user), invite });
  }),
);

// Deleting is for a mistake — somebody added by accident who never logged in.
// A person who has actually used the system is deactivated instead, so what
// they did stays attributable.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT id, last_login_at, invited_at FROM users WHERE id = $1',
      [req.params.id],
    );
    const user = rows[0];
    if (!user) throw new HttpError(404, 'User not found');
    if (req.user?.id === user.id) throw new HttpError(400, 'You can’t delete your own account.');
    // Only an invitation that was never taken up can be deleted. "No login
    // recorded" is not the same thing: accounts that predate staff accounts
    // have none either, and deleting one of those would destroy a colleague's
    // account rather than tidying away a mistake.
    const neverAccepted = !user.last_login_at && !!user.invited_at;
    if (!neverAccepted) {
      throw new HttpError(
        409,
        'This account is in use — deactivate it instead, so the work stays attributable.',
      );
    }
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.status(204).end();
  }),
);

export default router;
