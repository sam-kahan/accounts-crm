import { query, pool } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { dropDigitSlips } from './accountNumbers.js';

// ---------------------------------------------------------------------------
// Creating a complaint — one definition, used by the Log form, by a complaint
// started from an email, by one created automatically from the email that
// made it, and by importing a past complaint.
// ---------------------------------------------------------------------------

// Unambiguous characters only (no 0/O/1/I).
function makeRefCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return `GC-C-${s}`;
}

// `d` is the validated shape of POST /complaints. `raisedNote` replaces the
// first timeline entry's wording when the complaint was made some other way.
export async function createComplaint(d, { by = null, raisedNote = null, needsCheck = false } = {}) {
  const stage = d.stage || 'stage_1';
  // A linked organisation brings its type: the type decides the default for
  // anything its procedure doesn't state.
  if (d.organisation_id) {
    const org = (await query('SELECT type FROM organisations WHERE id = $1', [d.organisation_id]))
      .rows[0];
    if (!org) throw new HttpError(400, 'That organisation no longer exists');
    d.org_type = org.type;
  }
  // An imported complaint already past Stage 1 has a clock that started on
  // its Stage 2 request, not on raised_on. Without that date there is no
  // honest due date to show, so none is stored (marked as set by hand, so
  // recalculating leaves it empty) until someone enters the request date.
  const unknownClock =
    d.imported && stage !== 'stage_1' && !d.stage_started_on && !d.response_due;
  const manual = Boolean(d.response_due || unknownClock);

  // Retry on the (astronomically unlikely) ref_code collision rather than
  // surfacing a 500 from the unique index.
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO complaints
          (organisation_id, org_name, org_type, reference, our_reference, property,
           subject, category, description, channel, raised_on, stage, state,
           response_due, response_due_manual, ref_code, acknowledged_on, responded_on,
           imported, stage_started_on, final_response_on, account_numbers, outcome_wanted, losses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [
          d.organisation_id || null, d.org_name, d.org_type || 'council',
          d.reference || null, d.our_reference || null, d.property || null,
          d.subject, d.category || null, d.description || null, d.channel || 'email',
          d.raised_on, stage, d.response_due || null, manual, makeRefCode(),
          d.acknowledged_on || null, d.responded_on || null, d.imported || false,
          d.stage_started_on || (stage === 'stage_1' ? d.raised_on : null),
          d.final_response_on || null,
          dropDigitSlips((Array.isArray(d.account_numbers) ? d.account_numbers : [])
            .map((a) => String(a || '').trim().slice(0, 40)).filter(Boolean)).kept.slice(0, 6),
          // For the ombudsman, when given (the API; the complaint page asks for them later).
          (d.outcome_wanted || '').trim() || null, (d.losses || '').trim() || null,
        ],
      );
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1, $2, 'raised', $3, $4)`,
        [
          rows[0].id, d.raised_on,
          raisedNote ||
            (d.imported
              ? `Existing complaint imported (raised via ${d.channel || 'email'})`
              : `Complaint raised via ${d.channel || 'email'}`),
          by,
        ],
      );
      if (needsCheck) {
        await client.query('UPDATE complaints SET needs_check = true WHERE id = $1', [rows[0].id]);
      }
      created = await recomputeDeadlines(rows[0].id, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Unique violation on the ref_code index — try a fresh code.
      if (err.code === '23505' && /ref_code/.test(`${err.constraint || ''}${err.detail || ''}`)) {
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  if (!created) throw new HttpError(500, 'Could not allocate a complaint reference; please retry.');
  return created;
}
