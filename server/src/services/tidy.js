import { ukDate } from './complaintRules.js';
import { plural } from '../lib/words.js';
import { query, pool } from '../db/pool.js';
import { todayISO } from '../lib/dates.js';
import { sameIssue, matchOrgName, sameOrgName } from './orgMatch.js';
import { recomputeDeadlines, recomputeForOrganisation, recomputePartyDeadlines } from './complaintDeadlines.js';
import { overallState } from './complaintParties.js';
import { scheduleReview } from './complaintReview.js';
import { dropDigitSlips } from './accountNumbers.js';

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

// Two complaints are against the same organisation: the same saved one, or
// the same name.
function sameOrganisation(a, b) {
  if (a.organisation_id && b.organisation_id) return a.organisation_id === b.organisation_id;
  return sameOrgName(a.linked_org || a.org_name, b.linked_org || b.org_name);
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
      if (!sameIssue(fa, fb)) continue;
      const pair = a.state !== 'open' && b.state === 'open' ? { keep: b, merge: a } : { keep: a, merge: b };
      // The same issue with two different organisations (LCS and British
      // Gas, matched on the account number): merging makes ONE complaint
      // with both organisations on it, each keeping its own procedure.
      pair.second_organisation = !sameOrganisation(a, b);
      complaintPairs.push(pair);
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

// Two records of the same organisation's track on one complaint (it was on
// both complaints merged, or two organisations merged into one): fold the
// source into the target. Blank dates and the reference are filled from the
// source, never overwriting; the source's timeline entries and emails are
// re-pointed to the target track (and Undo with them); a source party row is
// then removed. `fromPartyId` null = the main track of `fromComplaintId`;
// `targetPartyId` null = the target complaint's main track.
const FOLD_COLS = ['reference', 'acknowledged_on', 'responded_on', 'final_response_on', 'stage_started_on', 'outcome'];
async function foldTrack(client, { fromComplaintId, fromPartyId, source, target, targetTable, targetPartyId }) {
  const fill = {};
  for (const c of FOLD_COLS) if (!target[c] && source[c]) fill[c] = source[c];
  const cols = Object.keys(fill);
  if (cols.length) {
    await client.query(
      `UPDATE ${targetTable} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [target.id, ...cols.map((c) => fill[c])],
    );
  }
  const cond = fromPartyId ? 'party_id = $3::uuid' : 'party_id IS NULL AND $3::uuid IS NULL';
  await client.query(`UPDATE complaint_events SET party_id = $2 WHERE complaint_id = $1 AND ${cond}`, [fromComplaintId, targetPartyId, fromPartyId]);
  await client.query(`UPDATE complaint_emails SET party_id = $2 WHERE complaint_id = $1 AND ${cond}`, [fromComplaintId, targetPartyId, fromPartyId]);
  await client.query(
    `UPDATE complaint_emails
        SET applied = CASE WHEN $2::text IS NULL THEN applied - 'party_id'
                           ELSE jsonb_set(applied, '{party_id}', to_jsonb($2::text)) END
      WHERE complaint_id = $1 AND applied IS NOT NULL AND (applied->>'party_id') IS NOT DISTINCT FROM $3::text`,
    [fromComplaintId, targetPartyId, fromPartyId],
  );
  if (fromPartyId) await client.query('DELETE FROM complaint_parties WHERE id = $1', [fromPartyId]);
  const stageNote = source.stage && target.stage && source.stage !== target.stage
    ? ` (it was at ${source.stage.replace('_', ' ')} there, ${target.stage.replace('_', ' ')} here: check which is right)`
    : '';
  return { filled: cols, stageNote };
}

// The same organisation: the same saved one, or the same name.
const sameTrackOrg = (a, b) => (a.organisation_id && b.organisation_id
  ? a.organisation_id === b.organisation_id
  : sameOrgName(a.org_name, b.org_name));

async function orgName(client, id) {
  if (!id) return null;
  return (await client.query('SELECT name FROM organisations WHERE id = $1', [id])).rows[0]?.name || null;
}

// Merge complaint `mergeId` into `keepId`: every email, document, timeline
// entry and found thread moves across, blanks on the kept one are filled from
// the other, and the other is removed. One transaction: all of it or none.
export async function mergeComplaints(keepId, mergeId, by) {
  if (keepId === mergeId) throw Object.assign(new Error('Pick two different complaints.'), { status: 400 });
  const client = await pool.connect();
  let keep;
  let gone;
  let toRecompute = [];
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
    // Against a different organisation (the debt collector and the supplier):
    // the merged complaint's track becomes a further organisation on the kept
    // one, with its own reference, stage and dates — nothing of it is lost,
    // and none of it is taken for the kept organisation's.
    const secondOrg = !sameOrganisation(
      { ...keep, linked_org: await orgName(client, keep.organisation_id) },
      { ...gone, linked_org: await orgName(client, gone.organisation_id) },
    );
    const partyNotes = [];
    const foldedInto = [];
    let newParty = null;
    const keepParties = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [keepId])).rows;
    const goneParties = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [mergeId])).rows;
    if (secondOrg) {
      const already = keepParties.find((p) => sameTrackOrg(p, gone));
      if (already) {
        // That organisation is already on the kept complaint: this one's
        // details go onto its part, rather than a second copy of it.
        const r = await foldTrack(client, {
          fromComplaintId: mergeId, fromPartyId: null, source: gone,
          target: already, targetTable: 'complaint_parties', targetPartyId: already.id,
        });
        foldedInto.push(already.id);
        partyNotes.push(`${gone.org_name}'s details were added to its part of this complaint` +
          `${r.filled.length ? ` (filled in ${r.filled.map((c) => c.replace(/_/g, ' ')).join(', ')})` : ''}${r.stageNote}`);
      } else {
        const ended = ['resolved', 'closed'].includes(gone.stage) ? gone.stage
          : gone.state !== 'open' ? gone.state : null;
        newParty = (await client.query(
          `INSERT INTO complaint_parties
             (complaint_id, organisation_id, org_name, org_type, reference, raised_on, channel, stage, state,
              stage_started_on, acknowledged_on, responded_on, final_response_on, response_due,
              response_due_manual, ombudsman_deadline, outcome, closed_on, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [
            keepId, gone.organisation_id, gone.org_name, gone.org_type, gone.reference, gone.raised_on,
            gone.channel, ended || gone.stage, ended ? (ended === 'closed' ? 'closed' : 'resolved') : 'open',
            gone.stage_started_on, gone.acknowledged_on, gone.responded_on, gone.final_response_on,
            gone.response_due, gone.response_due_manual, gone.ombudsman_deadline, gone.outcome,
            gone.closed_on, by,
          ],
        )).rows[0];
        // Its timeline and emails are that organisation's, not the kept one's
        // (and Undo of an email recorded automatically goes to the new track).
        await foldTrack(client, {
          fromComplaintId: mergeId, fromPartyId: null, source: {}, target: newParty,
          targetTable: 'complaint_parties', targetPartyId: newParty.id,
        });
        keepParties.push(newParty);
        partyNotes.push(`${gone.org_name} is now a second organisation on this complaint, with its own reference and dates`);
      }
    }
    // Further organisations on the merged one: moved across, or — when that
    // organisation is already on the kept complaint — folded into its part
    // there, so nothing of it is lost to the delete below.
    const movedParties = [];
    for (const gp of goneParties) {
      if (sameTrackOrg(gp, keep)) {
        const r = await foldTrack(client, {
          fromComplaintId: mergeId, fromPartyId: gp.id, source: gp,
          target: keep, targetTable: 'complaints', targetPartyId: null,
        });
        partyNotes.push(`${gp.org_name}'s part from ${gone.ref_code} was added to this complaint's own${r.stageNote}`);
        continue;
      }
      const into = keepParties.find((p) => sameTrackOrg(p, gp));
      if (into) {
        const r = await foldTrack(client, {
          fromComplaintId: mergeId, fromPartyId: gp.id, source: gp,
          target: into, targetTable: 'complaint_parties', targetPartyId: into.id,
        });
        partyNotes.push(`${gp.org_name}'s part from ${gone.ref_code} was added to its part here${r.stageNote}`);
        foldedInto.push(into.id);
        continue;
      }
      await client.query('UPDATE complaint_parties SET complaint_id = $1 WHERE id = $2', [keepId, gp.id]);
      movedParties.push(gp.id);
      keepParties.push(gp);
    }
    const partyNote = partyNotes.length ? `; ${partyNotes.join('; ')}` : '';
    const moved = {};
    for (const t of ['complaint_emails', 'complaint_attachments', 'complaint_events']) {
      moved[t] = (await client.query(`UPDATE ${t} SET complaint_id = $1 WHERE complaint_id = $2`, [keepId, mergeId])).rowCount;
    }
    await client.query('UPDATE complaint_import_candidates SET complaint_id = $1 WHERE complaint_id = $2', [keepId, mergeId]);
    // Fill what the kept one is missing; never overwrite what it has. Their
    // reference, organisation and acknowledgement belong to the organisation:
    // taken only when it is the same one.
    const fill = {};
    const fillCols = secondOrg
      ? ['our_reference', 'property', 'category']
      : ['reference', 'our_reference', 'property', 'category', 'organisation_id', 'acknowledged_on'];
    for (const col of fillCols) {
      if (!keep[col] && gone[col]) fill[col] = gone[col];
    }
    // The account numbers are the issue's, whichever organisation quoted them.
    const accounts = dropDigitSlips([...new Set([...(keep.account_numbers || []), ...(gone.account_numbers || [])])]).kept;
    if (accounts.join('|') !== (keep.account_numbers || []).join('|')) fill.account_numbers = accounts;
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
        `Merged in ${gone.ref_code} ("${gone.subject}", raised ${ukDate(gone.raised_on)}): ` +
          `${plural(moved.complaint_emails, 'email')}, ${plural(moved.complaint_attachments, 'document')}, ` +
          `${plural(moved.complaint_events, 'timeline entry', 'timeline entries')} moved here` +
          (cols.length ? `; filled in ${cols.map((c) => c.replace(/_/g, ' ')).join(', ')}` : '') + partyNote + '.',
        by,
      ],
    );
    // Open while any organisation's part of it is.
    const k = (await client.query('SELECT * FROM complaints WHERE id = $1', [keepId])).rows[0];
    const ps = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [keepId])).rows;
    const state = overallState(k, ps);
    if (state !== k.state) {
      if (k.state !== 'open' && !['resolved', 'closed'].includes(k.stage)) {
        await client.query('UPDATE complaints SET stage = state WHERE id = $1', [keepId]);
      }
      await client.query('UPDATE complaints SET state = $2 WHERE id = $1', [keepId, state]);
    }
    toRecompute = [...new Set([...(newParty ? [newParty.id] : []), ...movedParties, ...foldedInto])];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // After the commit (so a failure here can't be mistaken for the merge failing).
  for (const id of toRecompute) await recomputePartyDeadlines(id);
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
    // A complaint that has BOTH organisations on it (one as its main, one as
    // a further organisation) would end up with the same one twice: the two
    // parts are folded into one first, and its timeline says so.
    const folded = [];
    const clash = (await client.query(
      `SELECT p.*, c.id AS cid FROM complaint_parties p JOIN complaints c ON c.id = p.complaint_id
        WHERE (c.organisation_id = $2 AND p.organisation_id = $1)
           OR (c.organisation_id = $1 AND p.organisation_id = $2)`,
      [keepId, mergeId],
    )).rows;
    for (const p of clash) {
      const main = (await client.query('SELECT * FROM complaints WHERE id = $1', [p.cid])).rows[0];
      const r = await foldTrack(client, {
        fromComplaintId: p.cid, fromPartyId: p.id, source: p, target: main, targetTable: 'complaints', targetPartyId: null,
      });
      folded.push([p.cid, `"${gone.name}" and "${keep.name}" are one organisation, so its two parts on this complaint were made one${r.stageNote}.`]);
    }
    // Likewise two further organisations on one complaint that become the same.
    const twin = (await client.query(
      `SELECT g.* , k.id AS into_id FROM complaint_parties g
         JOIN complaint_parties k ON k.complaint_id = g.complaint_id AND k.organisation_id = $1
        WHERE g.organisation_id = $2`,
      [keepId, mergeId],
    )).rows;
    for (const g of twin) {
      const into = (await client.query('SELECT * FROM complaint_parties WHERE id = $1', [g.into_id])).rows[0];
      const r = await foldTrack(client, {
        fromComplaintId: g.complaint_id, fromPartyId: g.id, source: g, target: into, targetTable: 'complaint_parties', targetPartyId: into.id,
      });
      folded.push([g.complaint_id, `"${gone.name}" and "${keep.name}" are one organisation, so its two parts on this complaint were made one${r.stageNote}.`]);
    }
    for (const [cid, note] of folded) {
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [cid, todayISO(), note, by],
      );
    }
    moved = (await client.query(
      'UPDATE complaints SET organisation_id = $1, org_type = $3 WHERE organisation_id = $2 RETURNING id',
      [keepId, mergeId, keep.type],
    )).rows.map((r) => r.id);
    await client.query('UPDATE organisation_documents SET organisation_id = $1 WHERE organisation_id = $2', [keepId, mergeId]);
    // As a further organisation on complaints too — except where the kept one
    // is already on that complaint (it would be there twice).
    await client.query(
      `UPDATE complaint_parties p SET organisation_id = $1, org_type = $3
        WHERE p.organisation_id = $2 AND NOT EXISTS (
          SELECT 1 FROM complaint_parties q WHERE q.complaint_id = p.complaint_id AND q.organisation_id = $1)
          AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.id = p.complaint_id AND c.organisation_id = $1)`,
      [keepId, mergeId, keep.type],
    );
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
