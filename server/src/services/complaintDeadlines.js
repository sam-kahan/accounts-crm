import { schemeFor } from './ombudsmen.js';
import { query } from '../db/pool.js';
import {
  effectiveRule,
  computeResponseDue,
  computeOmbudsmanDeadline,
  readable,
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
  // The ombudsman's own time limit and wait come from the register.
  const schemes = (await db.query('SELECT * FROM ombudsmen')).rows;
  return { org, rule: effectiveRule(org, c.org_type, schemeFor(org, c.org_type, schemes)) };
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

// The same for one further organisation on a complaint (complaint_parties,
// migration 029): its own procedure, its own clock.
export async function recomputePartyDeadlines(partyId, db = { query }) {
  const p = (await db.query('SELECT * FROM complaint_parties WHERE id = $1', [partyId])).rows[0];
  if (!p) return null;
  const { rule } = await ruleForComplaint(p, db);
  const responseDue = p.response_due_manual ? p.response_due : computeResponseDue(p, rule);
  const ombudsmanDeadline = computeOmbudsmanDeadline(p, rule);
  const { rows } = await db.query(
    `UPDATE complaint_parties SET response_due = $2, ombudsman_deadline = $3
      WHERE id = $1 RETURNING *`,
    [partyId, responseDue, ombudsmanDeadline],
  );
  return rows[0];
}

// After an organisation's procedure is edited (or the organisation removed),
// every OPEN complaint against it is re-dated. Closed ones keep the dates they
// were handled against. Each date that moved is written on that complaint's
// timeline ("Stage 1 outcome due 22 Oct → 19 Oct"), and its AI review is
// refreshed so the next step follows the new rules.
// `reviewAll: false` (the start-up correction): only complaints whose dates
// actually moved get a fresh AI review — the rest are unchanged and a review
// each would be paid for nothing.
// Further organisations on complaints that aren't linked to a saved
// organisation (so no organisation re-dates them): re-dated by type, each
// moved refer-by date noted on the complaint's timeline.
export async function recomputeLooseParties(types, { by, source }) {
  const { todayISO } = await import('../lib/dates.js');
  const rows = (await query(
    `SELECT p.id, p.complaint_id, p.org_name, p.ombudsman_deadline FROM complaint_parties p JOIN complaints c ON c.id = p.complaint_id
      WHERE c.state = 'open' AND p.state = 'open' AND p.organisation_id IS NULL AND ($1::text[] IS NULL OR p.org_type = ANY($1::text[]))`,
    [types],
  )).rows;
  for (const p of rows) {
    const after = await recomputePartyDeadlines(p.id);
    if (after && (p.ombudsman_deadline || null) !== (after.ombudsman_deadline || null)) {
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
        [p.complaint_id, p.id, todayISO(), `${p.org_name}: refer-by date ${readable(p.ombudsman_deadline) || '(none)'} → ${readable(after.ombudsman_deadline) || '(none)'} (from ${source}).`, by],
      );
    }
  }
  return rows.length;
}

export async function recomputeForOrganisation(orgId, extraIds = [], { by = 'Automatic (procedure updated)', reviewAll = true, source: sourceOverride = null } = {}) {
  const { rows } = await query(
    `SELECT id, response_due, ombudsman_deadline, stage FROM complaints
      WHERE state = 'open' AND (organisation_id = $1 OR id = ANY($2::uuid[]))`,
    [orgId, extraIds],
  );
  const org = orgId ? (await query('SELECT name, procedure_ref FROM organisations WHERE id = $1', [orgId])).rows[0] : null;
  const source = sourceOverride || (org ? (org.procedure_ref || `${org.name}'s procedure`) : 'the general timescales');
  const { scheduleReview } = await import('./complaintReview.js');
  const { todayISO } = await import('../lib/dates.js');
  let changed = 0;
  for (const r of rows) {
    const after = await recomputeDeadlines(r.id);
    if (!after) continue; // removed (merged or deleted) since the list was read
    const moves = [];
    const label = r.stage === 'stage_2' ? 'Stage 2 response due' : 'Stage 1 outcome due';
    if ((r.response_due || null) !== (after.response_due || null)) {
      moves.push(`${label} ${readable(r.response_due) || '(none)'} → ${readable(after.response_due) || '(none)'}`);
    }
    if ((r.ombudsman_deadline || null) !== (after.ombudsman_deadline || null)) {
      moves.push(`refer-by date ${readable(r.ombudsman_deadline) || '(none)'} → ${readable(after.ombudsman_deadline) || '(none)'}`);
    }
    if (moves.length) {
      changed += 1;
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [r.id, todayISO(), `Deadlines updated from ${source}: ${moves.join('; ')}.`, by],
      );
    }
    if (moves.length || reviewAll) scheduleReview(r.id);
  }
  // The same organisation as a further party on other complaints (LCS on a
  // British Gas complaint): its track there follows its procedure too.
  const parties = orgId
    ? (await query(
      `SELECT p.id, p.complaint_id, p.org_name, p.response_due, p.ombudsman_deadline, p.stage
         FROM complaint_parties p JOIN complaints c ON c.id = p.complaint_id
        WHERE c.state = 'open' AND p.state = 'open' AND p.organisation_id = $1`,
      [orgId],
    )).rows
    : [];
  for (const p of parties) {
    const after = await recomputePartyDeadlines(p.id);
    if (!after) continue;
    const moves = [];
    const label = p.stage === 'stage_2' ? 'Stage 2 response due' : 'Stage 1 outcome due';
    if ((p.response_due || null) !== (after.response_due || null)) {
      moves.push(`${label} ${readable(p.response_due) || '(none)'} → ${readable(after.response_due) || '(none)'}`);
    }
    if ((p.ombudsman_deadline || null) !== (after.ombudsman_deadline || null)) {
      moves.push(`refer-by date ${readable(p.ombudsman_deadline) || '(none)'} → ${readable(after.ombudsman_deadline) || '(none)'}`);
    }
    if (moves.length) {
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
         VALUES ($1,$2,$3,'note',$4,$5)`,
        [p.complaint_id, p.id, todayISO(), `${p.org_name}: deadlines updated from ${source}: ${moves.join('; ')}.`, by],
      );
    }
    if (moves.length || reviewAll) scheduleReview(p.complaint_id);
  }
  return rows.length + parties.length;
}
