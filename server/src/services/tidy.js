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
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const STAGE_ORDER = { stage_1: 1, stage_2: 2, ombudsman: 3 };
const STAGE_WORD = { stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'the ombudsman' };
const DATE_WORD = { acknowledged_on: 'acknowledged', responded_on: 'responded', final_response_on: 'final response' };
const trackIsOpen = (t) => (t.state || 'open') === 'open' && !['resolved', 'closed'].includes(t.stage);

// Two records of the SAME organisation's complaint being combined (the same
// account complained about twice, or a supplier added to a collector's
// complaint while its own was open). Pure. Returns the values to write onto
// `target`, and notes for the timeline. The rule, so nothing is lost or
// moved backwards:
//   - it was made on the EARLIER date of the two;
//   - it is at the FURTHER stage of the two (an open one's), with that
//     stage's start date and response; never moved back;
//   - a date only one has is kept; two different dates keep the one from the
//     record whose stage is kept, and the other is written in the notes.
export function combineTracks(source, target) {
  const fill = {};
  const notes = [];
  const sr = dayOf(source.raised_on);
  const tr = dayOf(target.raised_on);
  if (sr && (!tr || sr < tr)) {
    fill.raised_on = sr;
    notes.push(`made on ${ukDate(sr)} (the earlier of the two${tr ? `; the other was ${ukDate(tr)}` : ''})`);
  }
  const lead = trackIsOpen(source) && (STAGE_ORDER[source.stage] || 0) > (STAGE_ORDER[target.stage] || 0) ? source : target;
  if (lead === source) {
    fill.stage = source.stage;
    fill.stage_started_on = dayOf(source.stage_started_on);
    fill.responded_on = dayOf(source.responded_on); // the answer at THIS stage
    notes.push(`at ${STAGE_WORD[source.stage] || source.stage}, as the other record was${target.stage ? ` (this one was at ${STAGE_WORD[target.stage] || target.stage})` : ''}`);
  } else if (source.stage === target.stage) {
    const ss = dayOf(source.stage_started_on) || (source.stage === 'stage_1' ? sr : null);
    const ts = dayOf(target.stage_started_on) || (target.stage === 'stage_1' ? tr : null);
    if (ss && (!ts || ss < ts)) fill.stage_started_on = ss;
  }
  const other = lead === source ? target : source;
  for (const col of ['acknowledged_on', 'responded_on', 'final_response_on']) {
    if (col === 'responded_on' && lead === source) continue; // set above, for its stage
    if (col === 'responded_on' && source.stage !== target.stage) continue; // another stage's answer
    const kept = dayOf(lead[col]);
    const alt = dayOf(other[col]);
    const now = dayOf(target[col]);
    const want = kept || alt || null;
    if (want !== now) fill[col] = want;
    if (kept && alt && kept !== alt) notes.push(`${DATE_WORD[col]} ${ukDate(kept)} kept (the other record says ${ukDate(alt)})`);
  }
  // Two references for the same organisation's part: the kept one stays its
  // reference, and the other is kept too (other_references), so an email
  // quoting it still finds the complaint.
  const otherRefs = [];
  if (source.reference && !target.reference) fill.reference = source.reference;
  else if (source.reference && target.reference
    && String(source.reference).trim().toLowerCase() !== String(target.reference).trim().toLowerCase()) {
    otherRefs.push(String(source.reference).trim());
    notes.push(`their other reference ${String(source.reference).trim()} kept as well`);
  }
  if (source.outcome && !target.outcome) fill.outcome = source.outcome;
  if (Object.keys(fill).some((k) => ['raised_on', 'stage', 'stage_started_on'].includes(k))) fill.response_due_manual = false;
  return { fill, notes, otherRefs };
}
async function foldTrack(client, { fromComplaintId, fromPartyId, source, target, targetTable, targetPartyId }) {
  // Nothing of either is lost or moved backwards (combineTracks).
  const { fill, notes, otherRefs } = combineTracks(source, target);
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
  // The complaint the kept part belongs to (its other references are kept
  // there), and what pointed at the part being folded now points at the kept
  // one: emails waiting to go or sent (so a Stage 2 request sent from here
  // still moves the right part, and a second press is still recognised),
  // and a "Looks resolved" prompt (so resolving that part clears it).
  const ownerId = targetTable === 'complaints' ? target.id : target.complaint_id;
  if (otherRefs.length && ownerId) {
    await client.query(
      `UPDATE complaints SET other_references = ARRAY(SELECT DISTINCT x FROM unnest(other_references || $2::text[]) x) WHERE id = $1`,
      [ownerId, otherRefs],
    );
  }
  await client.query(
    `UPDATE complaint_outbox SET complaint_id = $2, party_id = $3::uuid, to_party = ($3::uuid IS NOT NULL)
      WHERE complaint_id = $1 AND then_supplier IS NULL AND ${fromPartyId ? 'party_id = $4::uuid' : 'party_id IS NULL AND NOT to_party AND $4::uuid IS NULL'}`,
    [fromComplaintId, ownerId || fromComplaintId, targetPartyId, fromPartyId],
  );
  await client.query(
    `UPDATE complaints
        SET resolution_suggested = CASE WHEN $3::text IS NULL THEN resolution_suggested - 'party_id'
                                        ELSE jsonb_set(resolution_suggested, '{party_id}', to_jsonb($3::text)) END
      WHERE id = $1 AND resolution_suggested IS NOT NULL AND (resolution_suggested->>'party_id') IS NOT DISTINCT FROM $2::text`,
    [fromComplaintId, fromPartyId, targetPartyId],
  );
  if (fromPartyId) await client.query('DELETE FROM complaint_parties WHERE id = $1', [fromPartyId]);
  const stageNote = notes.length ? ` (${notes.join('; ')})` : '';
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
// How a filled-in column reads in the merge's timeline note.
const MERGE_LABEL = {
  outcome_wanted: 'the outcome we want', losses: 'money lost or extra costs', removed_orgs: 'organisations taken off',
  account_numbers: 'account number', our_reference: 'our reference', organisation_id: 'the saved organisation',
  needs_check: '"To check" (the other was not checked yet)', complaint_doubt: 'the open question about the complaint',
  resolution_suggested: 'the "Looks resolved" prompt',
};

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
    // An email still waiting on either (being sent, or failed with Try
    // again / It went) is dealt with first: the merge would delete the
    // merged one's with it, or leave an email that goes out with nowhere to
    // be recorded and its step never taken. The row locks above hold off a
    // new one being queued meanwhile.
    const waiting = (await client.query(
      `SELECT count(*)::int AS n FROM complaint_outbox WHERE complaint_id = ANY($1::uuid[]) AND status <> 'sent'`,
      [[keepId, mergeId]],
    )).rows[0].n;
    if (waiting) {
      throw Object.assign(new Error(`An email from one of these complaints is still being sent, or failed and is waiting on the complaint. Deal with it first (it has Try again and Discard on the complaint), then combine them.`), { status: 409 });
    }
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
    const moved = {};
    for (const t of ['complaint_emails', 'complaint_attachments', 'complaint_events']) {
      moved[t] = (await client.query(`UPDATE ${t} SET complaint_id = $1 WHERE complaint_id = $2`, [keepId, mergeId])).rowCount;
    }
    // Bounces and the emails sent from it come too: its sent emails are what
    // tells a second press of Send from a new email, and a bounce not looked
    // into must still show.
    await client.query('UPDATE email_bounces SET complaint_id = $1 WHERE complaint_id = $2', [keepId, mergeId]);
    await client.query('UPDATE complaint_outbox SET complaint_id = $1 WHERE complaint_id = $2', [keepId, mergeId]);
    await client.query('UPDATE complaint_import_candidates SET complaint_id = $1 WHERE complaint_id = $2', [keepId, mergeId]);
    // Fill what the kept one is missing; never overwrite what it has. Their
    // reference, organisation and acknowledgement belong to the organisation:
    // taken only when it is the same one.
    const fill = {};
    const fillCols = secondOrg
      ? ['our_reference', 'property', 'category']
      : ['our_reference', 'property', 'category', 'organisation_id'];
    for (const col of fillCols) {
      if (!keep[col] && gone[col]) fill[col] = gone[col];
    }
    // The same organisation on both: its complaint's date, stage and dates
    // are combined by the same rule as a further organisation's part (the
    // earlier date, the further stage, no date lost), said on the timeline.
    const extraRefs = [...(gone.other_references || [])];
    if (!secondOrg) {
      const t = combineTracks(gone, keep);
      Object.assign(fill, t.fill);
      extraRefs.push(...t.otherRefs);
      const said = t.notes.filter((n) => !n.startsWith('their other reference'));
      if (said.length) partyNotes.push(`the complaint is ${said.join('; ')}`);
      partyNotes.push(...t.notes.filter((n) => n.startsWith('their other reference')));
    }
    // Still to be checked if either was (an import nobody has checked), and
    // an open question or a "Looks resolved" prompt on the merged one is
    // kept when the kept one has none: dropping them would open a referral
    // the question held back, or lose the prompt.
    if (gone.needs_check && !keep.needs_check) fill.needs_check = true;
    if (gone.complaint_doubt && !gone.complaint_doubt.answered && !keep.complaint_doubt) {
      fill.complaint_doubt = JSON.stringify(gone.complaint_doubt);
    }
    const goneNow = (await client.query('SELECT resolution_suggested FROM complaints WHERE id = $1', [mergeId])).rows[0];
    if (goneNow?.resolution_suggested && !keep.resolution_suggested) {
      fill.resolution_suggested = JSON.stringify(goneNow.resolution_suggested);
    }
    // The account numbers are the issue's, whichever organisation quoted them.
    const accounts = dropDigitSlips([...new Set([...(keep.account_numbers || []), ...(gone.account_numbers || [])])]).kept;
    if (accounts.join('|') !== (keep.account_numbers || []).join('|')) fill.account_numbers = accounts;
    if (gone.description && gone.description !== keep.description) {
      fill.description = [keep.description, `From ${gone.ref_code}: ${gone.description}`].filter(Boolean).join('\n\n');
    }
    // What we want and what it cost (for the ombudsman): never lost, and
    // two different statements are both kept, each saying where it came from.
    for (const col of ['outcome_wanted', 'losses']) {
      if (gone[col] && gone[col] !== keep[col]) {
        fill[col] = keep[col] ? `${keep[col]}\n\nFrom ${gone.ref_code}: ${gone[col]}` : gone[col];
      }
    }
    // Organisations taken off either one stay off the merged complaint (their
    // emails and entries moved here still carry their tag).
    const offBoth = [...(keep.removed_orgs || [])];
    for (const r of gone.removed_orgs || []) {
      if (!offBoth.some((x) => x.name === r.name && (x.organisation_id || null) === (r.organisation_id || null))) offBoth.push(r);
    }
    if (offBoth.length !== (keep.removed_orgs || []).length) fill.removed_orgs = JSON.stringify(offBoth);
    const cols = Object.keys(fill);
    if (cols.length) {
      await client.query(
        `UPDATE complaints SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [keepId, ...cols.map((c) => fill[c])],
      );
    }
    // What the merged one was known by still finds this one: its GC-C code
    // (its own address, and the code in an email) and their other
    // references.
    await client.query(
      `UPDATE complaints
          SET merged_refs = ARRAY(SELECT DISTINCT x FROM unnest(merged_refs || $2::text[]) x),
              other_references = ARRAY(SELECT DISTINCT x FROM unnest(other_references || $3::text[]) x WHERE x <> '')
        WHERE id = $1`,
      [keepId, [gone.ref_code, ...(gone.merged_refs || [])], extraRefs.filter((r) => r && r !== keep.reference)],
    );
    await client.query('DELETE FROM complaints WHERE id = $1', [mergeId]);
    await client.query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [
        keepId, todayISO(),
        `Merged in ${gone.ref_code} ("${gone.subject}", raised ${ukDate(gone.raised_on)}): ` +
          `${plural(moved.complaint_emails, 'email')}, ${plural(moved.complaint_attachments, 'document')}, ` +
          `${plural(moved.complaint_events, 'timeline entry', 'timeline entries')} moved here` +
          (cols.length ? `; filled in ${cols.map((c) => MERGE_LABEL[c] || c.replace(/_/g, ' ')).join(', ')}` : '') + (partyNotes.length ? `; ${partyNotes.join('; ')}` : '') + '.',
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
    // An email waiting to go on a complaint either organisation is on is
    // dealt with first: folding a part away, or a supplier still to be added
    // under the organisation being removed, would leave it pointing at
    // something that no longer exists.
    const waiting = (await client.query(
      `SELECT count(*)::int AS n FROM complaint_outbox o JOIN complaints c ON c.id = o.complaint_id
        WHERE o.status <> 'sent' AND (c.organisation_id = ANY($1::uuid[])
           OR EXISTS (SELECT 1 FROM complaint_parties p WHERE p.complaint_id = c.id AND p.organisation_id = ANY($1::uuid[]))
           OR (o.then_supplier->>'organisation_id') = ANY($1::text[]))`,
      [[keepId, mergeId]],
    )).rows[0].n;
    if (waiting) {
      throw Object.assign(new Error('An email on a complaint with one of these organisations is still being sent, or failed and is waiting. Deal with it first (Try again or Discard on the complaint), then merge them.'), { status: 409 });
    }
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
    // Their procedure and ombudsman scheme: what the kept one doesn't state is
    // taken from the merged one, with where it came from, so nothing
    // researched (and paid for) is lost and no scheme drops away. A figure
    // that sets a date filled in this way needs checking again.
    const PROC = ['ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock', 'ombudsman_name', 'ombudsman_url',
      'ombudsman_referral_months', 'referral_from', 'ombudsman_after_weeks', 'legal_basis', 'procedure_ref', 'ombudsman_id', 'procedure_summary'];
    const own = (o, col) => o[col] !== null && o[col] !== undefined && o[col] !== '' && o.procedure_sources?.[col] !== 'standard';
    const sources = { ...(keep.procedure_sources || {}) };
    const evidence = { ...(keep.procedure_evidence || {}) };
    let procFilled = false;
    for (const col of PROC) {
      if (!own(keep, col) && own(gone, col)) {
        fill[col] = gone[col];
        if (gone.procedure_sources?.[col]) sources[col] = gone.procedure_sources[col];
        if (gone.procedure_evidence?.[col]) evidence[col] = gone.procedure_evidence[col];
        procFilled = true;
      }
    }
    if (procFilled) {
      fill.procedure_sources = JSON.stringify(sources);
      fill.procedure_evidence = JSON.stringify(evidence);
      fill.verified_at = null;
      fill.verified_by = null;
    }
    // Research done on either counts (never paid for twice).
    if (!keep.researched_at && gone.researched_at) fill.researched_at = gone.researched_at;
    const RANK = { none: 0, failed: 0, manual: 1, researched: 2, document: 3 };
    if ((RANK[gone.research_status] || 0) > (RANK[keep.research_status] || 0)) fill.research_status = gone.research_status;
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
