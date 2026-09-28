import { query, pool } from '../db/pool.js';
import { todayISO } from '../lib/dates.js';
import { sameIssue, matchOrgName } from './orgMatch.js';
import { recomputeDeadlines, recomputeForOrganisation } from './complaintDeadlines.js';
import { scheduleReview } from './complaintReview.js';

// ---------------------------------------------------------------------------
// Keeping the records tidy. Complaints and organisations arrive from several
// directions now (the Log form, emails, the past-complaints search), so the
// same issue or the same body can end up on file twice. This finds the likely
// pairs and merges one into the other on a person's click — never on its own:
// a merge moves records, and a wrong one is worse than a duplicate. Nothing is
// lost: every email, document and timeline entry moves, and the timeline says
// what was merged, from where, and by whom.
// ---------------------------------------------------------------------------

const STATUS_RANK = { document: 3, researched: 2, manual: 1, none: 0 };

// Which of two organisations to keep: the one whose procedure someone has
// checked, then the better-sourced procedure, then the fuller name, then the
// older record.
function keepOrg(a, b) {
  const score = (o) => [o.verified_at ? 1 : 0, STATUS_RANK[o.research_status] || 0, (o.name || '').length, -new Date(o.created_at).getTime()];
  const sa = score(a);
  const sb = score(b);
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sa[i] > sb[i] ? [a, b] : [b, a];
  return [a, b];
}

export async function tidySuggestions() {
  const complaints = (await query(
    `SELECT c.id, c.ref_code, c.subject, c.org_name, c.organisation_id, c.property, c.raised_on, c.state,
            c.reference, c.our_reference, c.account_numbers,
            c.imported, o.name AS linked_org,
            (SELECT count(*)::int FROM complaint_emails e WHERE e.complaint_id = c.id) AS emails
       FROM complaints c LEFT JOIN organisations o ON o.id = c.organisation_id
      ORDER BY c.raised_on, c.created_at`,
  )).rows;
  const complaintPairs = [];
  for (let i = 0; i < complaints.length; i += 1) {
    for (let j = i + 1; j < complaints.length; j += 1) {
      const a = complaints[i];
      const b = complaints[j];
      if (a.state !== 'open' && b.state !== 'open') continue; // both finished: leave history alone
      const fa = { ...a, org_name: a.linked_org || a.org_name };
      const fb = { ...b, org_name: b.linked_org || b.org_name };
      // Keep the open one (its clock and next step are live); if both are
      // open, keep the older one.
      if (sameIssue(fa, fb)) complaintPairs.push(a.state !== 'open' && b.state === 'open' ? { keep: b, merge: a } : { keep: a, merge: b });
    }
  }

  const orgs = (await query(
    `SELECT o.*, (SELECT count(*)::int FROM complaints c WHERE c.organisation_id = o.id) AS complaint_count
       FROM organisations o ORDER BY created_at`,
  )).rows;
  const orgPairs = [];
  for (let i = 0; i < orgs.length; i += 1) {
    for (let j = i + 1; j < orgs.length; j += 1) {
      if (matchOrgName([orgs[i]], orgs[j].name) || matchOrgName([orgs[j]], orgs[i].name)) {
        const [keep, merge] = keepOrg(orgs[i], orgs[j]);
        orgPairs.push({
          keep: { id: keep.id, name: keep.name, verified: Boolean(keep.verified_at), complaint_count: keep.complaint_count },
          merge: { id: merge.id, name: merge.name, verified: Boolean(merge.verified_at), complaint_count: merge.complaint_count },
        });
      }
    }
  }
  return { complaints: complaintPairs, organisations: orgPairs };
}

// Merge complaint `mergeId` into `keepId`: every email, document, timeline
// entry and found thread moves across, blanks on the kept one are filled from
// the other, and the other is removed. One transaction: all of it or none.
export async function mergeComplaints(keepId, mergeId, by) {
  if (keepId === mergeId) throw Object.assign(new Error('Pick two different complaints.'), { status: 400 });
  const client = await pool.connect();
  let keep;
  let gone;
  try {
    await client.query('BEGIN');
    keep = (await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [keepId])).rows[0];
    gone = (await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [mergeId])).rows[0];
    if (!keep || !gone) throw Object.assign(new Error('One of those complaints no longer exists.'), { status: 404 });
    // Never merge a live complaint into a finished one: its stage, dates and
    // deadlines would be thrown away and the complaint would read as closed.
    if (keep.state !== 'open' && gone.state === 'open') {
      [keep, gone] = [gone, keep];
      [keepId, mergeId] = [mergeId, keepId];
    }
    const moved = {};
    for (const t of ['complaint_emails', 'complaint_attachments', 'complaint_events']) {
      moved[t] = (await client.query(`UPDATE ${t} SET complaint_id = $1 WHERE complaint_id = $2`, [keepId, mergeId])).rowCount;
    }
    await client.query('UPDATE complaint_import_candidates SET complaint_id = $1 WHERE complaint_id = $2', [keepId, mergeId]);
    // Fill what the kept one is missing; never overwrite what it has.
    const fill = {};
    for (const col of ['reference', 'our_reference', 'property', 'category', 'organisation_id', 'acknowledged_on']) {
      if (!keep[col] && gone[col]) fill[col] = gone[col];
    }
    if (gone.description && gone.description !== keep.description) {
      fill.description = [keep.description, `From ${gone.ref_code}: ${gone.description}`].filter(Boolean).join('\n\n');
    }
    const cols = Object.keys(fill);
    if (cols.length) {
      await client.query(
        `UPDATE complaints SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [keepId, ...cols.map((c) => fill[c])],
      );
    }
    await client.query('DELETE FROM complaints WHERE id = $1', [mergeId]);
    await client.query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [
        keepId, todayISO(),
        `Merged in ${gone.ref_code} ("${gone.subject}", raised ${gone.raised_on}): ` +
          `${moved.complaint_emails} email(s), ${moved.complaint_attachments} document(s), ` +
          `${moved.complaint_events} timeline entr${moved.complaint_events === 1 ? 'y' : 'ies'} moved here` +
          (cols.length ? `; filled in ${cols.map((c) => c.replace(/_/g, ' ')).join(', ')}` : '') + '.',
        by,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recomputeDeadlines(keepId);
  scheduleReview(keepId);
  return { kept: keep.ref_code, merged: gone.ref_code };
}

// Merge organisation `mergeId` into `keepId`: its complaints and documents
// move across, and anything the kept one hasn't got (an email address, a
// procedure detail) is filled in from it. Its complaints are re-dated from the
// kept organisation's procedure.
export async function mergeOrganisations(keepId, mergeId, by) {
  if (keepId === mergeId) throw Object.assign(new Error('Pick two different organisations.'), { status: 400 });
  const client = await pool.connect();
  let moved = [];
  let names;
  try {
    await client.query('BEGIN');
    const keep = (await client.query('SELECT * FROM organisations WHERE id = $1 FOR UPDATE', [keepId])).rows[0];
    const gone = (await client.query('SELECT * FROM organisations WHERE id = $1 FOR UPDATE', [mergeId])).rows[0];
    if (!keep || !gone) throw Object.assign(new Error('One of those organisations no longer exists.'), { status: 404 });
    names = { kept: keep.name, merged: gone.name };
    moved = (await client.query(
      'UPDATE complaints SET organisation_id = $1, org_type = $3 WHERE organisation_id = $2 RETURNING id',
      [keepId, mergeId, keep.type],
    )).rows.map((r) => r.id);
    await client.query('UPDATE organisation_documents SET organisation_id = $1 WHERE organisation_id = $2', [keepId, mergeId]);
    const fill = {};
    for (const col of ['complaints_email', 'complaints_url', 'phone', 'location']) {
      if (!keep[col] && gone[col]) fill[col] = gone[col];
    }
    const note = `${keep.notes ? `${keep.notes}\n` : ''}Merged in "${gone.name}" on ${todayISO()} by ${by || 'someone'}.`;
    const cols = Object.keys(fill);
    await client.query(
      `UPDATE organisations SET notes = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')} WHERE id = $1`,
      [keepId, note, ...cols.map((c) => fill[c])],
    );
    await client.query('DELETE FROM organisations WHERE id = $1', [mergeId]);
    for (const id of moved) {
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [id, todayISO(), `Organisation "${gone.name}" merged into "${keep.name}"; deadlines now follow its procedure.`, by],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recomputeForOrganisation(keepId);
  return { ...names, complaints: moved.length };
}
