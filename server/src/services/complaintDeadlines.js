import { query } from '../db/pool.js';
import {
  effectiveRule,
  computeResponseDue,
  computeOmbudsmanDeadline,
} from './complaintRules.js';

// ---------------------------------------------------------------------------
// Keeps a complaint's STORED deadlines in step with the facts they are worked
// out from. response_due and ombudsman_deadline are stored (the lists, the
// digest and the dashboard sort and filter on them in SQL), so anything that
// changes an input — the organisation's procedure, the acknowledgement date
// when their Stage 1 clock starts from it, an escalation, a corrected date —
// must recalculate them, or the screen would keep quoting the date worked out
// from yesterday's facts. A response_due typed in by hand is left alone.
// ---------------------------------------------------------------------------

export async function ruleForComplaint(c, db = { query }) {
  let org = null;
  if (c.organisation_id) {
    org = (await db.query('SELECT * FROM organisations WHERE id = $1', [c.organisation_id]))
      .rows[0] || null;
  }
  return { org, rule: effectiveRule(org, c.org_type) };
}

export async function recomputeDeadlines(id, db = { query }) {
  const c = (await db.query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  if (!c) return null;
  const { rule } = await ruleForComplaint(c, db);
  const responseDue = c.response_due_manual ? c.response_due : computeResponseDue(c, rule);
  const ombudsmanDeadline = computeOmbudsmanDeadline(c, rule);
  const { rows } = await db.query(
    `UPDATE complaints SET response_due = $2, ombudsman_deadline = $3
      WHERE id = $1 RETURNING *`,
    [id, responseDue, ombudsmanDeadline],
  );
  return rows[0];
}

// After an organisation's procedure is edited (or the organisation removed),
// every OPEN complaint against it is re-dated. Closed ones keep the dates they
// were handled against.
export async function recomputeForOrganisation(orgId, extraIds = []) {
  const { rows } = await query(
    `SELECT id FROM complaints
      WHERE state = 'open' AND (organisation_id = $1 OR id = ANY($2::uuid[]))`,
    [orgId, extraIds],
  );
  for (const r of rows) await recomputeDeadlines(r.id);
  return rows.length;
}
