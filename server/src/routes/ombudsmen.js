import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { organisationsUsing, DEFAULT_SCHEME } from '../services/ombudsmen.js';
import { recomputeForOrganisation } from '../services/complaintDeadlines.js';

// ---------------------------------------------------------------------------
// The ombudsman register (migration 042): each scheme's rules for taking a
// case, with the source of each figure and who checked it. Mounted behind
// the complaints section (GET = view, PUT = edit).
// ---------------------------------------------------------------------------
const router = Router();

const who = (req) => req.user?.name || req.user?.email || 'Someone';

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = (await query('SELECT * FROM ombudsmen ORDER BY name')).rows;
    // Which organisations each one applies to (chosen, or usual for the type).
    const orgs = (await query('SELECT id, name, type, ombudsman_id FROM organisations ORDER BY name')).rows;
    res.json(rows.map((s) => {
      const types = Object.entries(DEFAULT_SCHEME).filter(([, k]) => k === s.key).map(([t]) => t);
      const using = orgs.filter((o) => o.ombudsman_id === s.id || (!o.ombudsman_id && types.includes(o.type)));
      return { ...s, usual_for: types, organisations: using.map((o) => ({ id: o.id, name: o.name })) };
    }));
  }),
);

const text = z.string().trim().max(4000).optional().nullable();
const input = z.object({
  name: z.string().trim().min(1).max(200),
  website: text, refer_url: text, phone: text, email: text, post: text,
  wait_weeks: z.number().int().min(1).max(104).optional().nullable(),
  after_final_response: z.boolean(),
  after_missed_deadline: z.boolean(),
  time_limit_months: z.number().int().min(1).max(120).optional().nullable(),
  time_limit_from: z.enum(['final_response', 'raised']).optional().nullable(),
  who_can_complain: text, representative: text, notes: text,
  what_to_include: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  // "Checked against their official website." Sent on every save: ticking it
  // stamps who and when; saving without it clears it, and a change to any
  // rule has to be checked again (the stamp stays only if nothing changed).
  verified: z.boolean(),
});

// The fields that decide WHEN a complaint can go, and the time limit.
const RULE_FIELDS = ['wait_weeks', 'after_final_response', 'after_missed_deadline', 'time_limit_months', 'time_limit_from'];

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Invalid id');
    const d = parse(input, req.body || {});
    const before = (await query('SELECT * FROM ombudsmen WHERE id = $1', [req.params.id])).rows[0];
    if (!before) throw new HttpError(404, 'Not found');
    const same = (k) => (before[k] ?? null) === (d[k] ?? null);
    const contentSame = [...RULE_FIELDS, 'name', 'website', 'refer_url', 'phone', 'email', 'post',
      'who_can_complain', 'representative', 'notes'].every(same) &&
      JSON.stringify(before.what_to_include || []) === JSON.stringify(d.what_to_include || []);
    // Kept as it was only when ticked and nothing changed; stamped afresh when
    // ticked after a change; cleared when not ticked.
    const keep = d.verified && before.verified_at && contentSame;
    const { rows } = await query(
      `UPDATE ombudsmen SET name=$2, website=$3, refer_url=$4, phone=$5, email=$6, post=$7,
              wait_weeks=$8, after_final_response=$9, after_missed_deadline=$10,
              time_limit_months=$11, time_limit_from=$12, who_can_complain=$13, representative=$14,
              what_to_include=$15, notes=$16,
              verified_at = CASE WHEN $17 THEN verified_at WHEN $18 THEN now() ELSE NULL END,
              verified_by = CASE WHEN $17 THEN verified_by WHEN $18 THEN $19 ELSE NULL END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, d.name, d.website || null, d.refer_url || null, d.phone || null, d.email || null, d.post || null,
        d.wait_weeks ?? null, d.after_final_response, d.after_missed_deadline,
        d.time_limit_months ?? null, d.time_limit_from || null, d.who_can_complain || null, d.representative || null,
        d.what_to_include || [], d.notes || null, Boolean(keep), Boolean(d.verified && !keep), who(req)],
    );
    // A change to when it can go, or the time limit, re-dates the open
    // complaints it applies to (each move written on their timeline).
    let recalculated = 0;
    if (!RULE_FIELDS.every(same)) {
      const opts = { by: `${who(req)} (ombudsman rules updated)`, source: `${rows[0].name}’s rules`, reviewAll: false };
      for (const orgId of await organisationsUsing(rows[0])) recalculated += (await recomputeForOrganisation(orgId, [], opts)) || 0;
      const types = Object.entries(DEFAULT_SCHEME).filter(([, k]) => k === rows[0].key).map(([t]) => t);
      const loose = (await query(
        `SELECT id FROM complaints WHERE state = 'open' AND organisation_id IS NULL AND org_type = ANY($1::text[])`, [types],
      )).rows.map((r) => r.id);
      if (loose.length) recalculated += (await recomputeForOrganisation(null, loose, opts)) || 0;
    }
    res.json({ ...rows[0], recalculated });
  }),
);

export default router;
