import { query } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { complaintEmailAddress, config } from '../config.js';
import {
  computeAckDue,
  computeOmbudsmanFrom,
  deriveStatus,
  procedureSteps,
  reviewSignature,
  effectiveRule,
  trackOpen,
  isStage2Request,
  procedureOnFile,
} from './complaintRules.js';
import { listComplaintEmails } from './emailIngest.js';
import { guardReview, nextDueFromThem, guardByOrg, composeByOrg, chaseHeldUntil } from './reviewGuard.js';
import { contactFor } from './trackContact.js';
import { attachmentTexts, attachmentBlocks } from './attachments.js';

// ---------------------------------------------------------------------------
// A complaint with everything worked out about it (status, procedure
// checklist, org context), and the full context the AI reads. Shared by the
// routes, the email processor and the automatic review, so all three see the
// same complaint.
// ---------------------------------------------------------------------------

// Attach derived status + rule + procedure checklist + org context to a row.
export async function decorate(c) {
  return (await decorateMany([c]))[0];
}

// The last day an email arrived FROM them on each complaint.
export async function lastTheirsByComplaint(ids) {
  const ours = String(config.complaintEmail.domain || '').toLowerCase();
  const { rows } = await query(
    `SELECT complaint_id,
            max(CASE WHEN analysis->>'sent_on' ~ '^\d{4}-\d{2}-\d{2}$'
                     THEN (analysis->>'sent_on')::date
                     ELSE (received_at AT TIME ZONE 'Europe/London')::date END) AS d
       FROM complaint_emails
      WHERE complaint_id = ANY($1::uuid[]) AND direction <> 'outbound'
        AND COALESCE(analysis->>'kind', '') <> 'our_email'
        AND lower(COALESCE(sender_email, '')) NOT LIKE '%@' || $2
      GROUP BY complaint_id`,
    [ids, ours],
  );
  return new Map(rows.map((x) => [x.complaint_id, x.d]));
}

// Many at once (the list, the dashboard): the organisations and the further
// organisations on each complaint (migration 029) are read in two queries
// rather than several per complaint.
export async function decorateMany(rows) {
  if (!rows.length) return [];
  const parties = (await query(
    'SELECT * FROM complaint_parties WHERE complaint_id = ANY($1::uuid[]) ORDER BY created_at',
    [rows.map((r) => r.id)],
  )).rows;
  const ids = [...new Set([...rows, ...parties].map((r) => r.organisation_id).filter(Boolean))];
  const orgs = ids.length
    ? new Map((await query('SELECT * FROM organisations WHERE id = ANY($1::uuid[])', [ids])).rows.map((o) => [o.id, o]))
    : new Map();
  const orgOf = (r) => (r.organisation_id ? orgs.get(r.organisation_id) || null : null);
  // When Greenco last wrote to them (a chaser logged, or an email of ours), so
  // a stored review is checked against it as it is shown (reviewGuard.js).
  const lastSent = new Map((await query(
    `SELECT complaint_id, max(d) AS d FROM (
        SELECT complaint_id, event_date AS d FROM complaint_events
         WHERE type = 'chased' AND complaint_id = ANY($1::uuid[])
        UNION ALL
        SELECT complaint_id, (received_at AT TIME ZONE 'Europe/London')::date FROM complaint_emails
         WHERE direction = 'outbound' AND complaint_id = ANY($1::uuid[])
      ) x GROUP BY complaint_id`,
    [rows.map((r) => r.id)],
  )).rows.map((x) => [x.complaint_id, x.d]));
  // When they last wrote to us: the date on their email (as read), or the
  // day it arrived — never ours, a forward of ours included.
  const lastTheirs = await lastTheirsByComplaint(rows.map((r) => r.id));
  // With more than one organisation, each one's own correspondence.
  const partiesOf = (id) => parties.filter((p) => p.complaint_id === id);
  const contact = await contactFor(
    rows.filter((r) => partiesOf(r.id).length), partiesOf, [...orgs.values()], config.complaintEmail.domain,
  );
  return rows.map((r) => {
    const c = withParties(
      decorateWithOrg(r, orgOf(r)),
      parties.filter((p) => p.complaint_id === r.id).map((p) => decorateTrack(p, orgOf(p))),
    );
    // Overdue isn't the same as "chase them now": when Greenco has just
    // written to them, the next step is to wait (reviewGuard.js), so the
    // "Need chasing" list and counts use chase_now, and say until when it is
    // held. The overdue status itself is left as it is: it is still true.
    const byTrack = contact.get(r.id);
    for (const t of tracksForReview(c)) {
      const own = t.key === 'main' ? c : c.parties.find((p) => p.id === t.key);
      if (!own?.needs_chasing) continue;
      const k = c.parties.length ? byTrack?.get(t.key) || {} : { lastSentOn: lastSent.get(r.id) || null, lastTheirsOn: lastTheirs.get(r.id) || null };
      own.chase_held_until = chaseHeldUntil({ lastSentOn: k.lastSentOn || null, lastTheirsOn: k.lastTheirsOn || null, nextDue: nextDueFromThem([own]) });
    }
    for (const t of [c, ...c.parties]) t.chase_now = Boolean(t.needs_chasing && !t.chase_held_until);
    c.any_chase_now = [c, ...c.parties].some((t) => t.chase_now);
    // Never "chase" what isn't due, or straight after writing to them —
    // applied to the review as shown, so one written before this rule (or
    // before the dates moved) can't say otherwise.
    if (c.ai_review) {
      c.ai_review = guardReview(c.ai_review, {
        anyOverdue: c.any_needs_chasing,
        nextDue: nextDueFromThem([c, ...c.parties]),
        lastSentOn: lastSent.get(r.id) || null,
        lastTheirsOn: lastTheirs.get(r.id) || null,
        stage2Asked: stage2Asked([c, ...c.parties]),
      });
      // Whether its email IS the Stage 2 request (read from its words), so
      // the page offers "Send it and escalate" whatever the review called
      // its next step.
      if (c.ai_review?.email) c.ai_review.email_step = isStage2Request(c.ai_review.email) ? 'stage2_request' : null;
      // Each organisation's own step, checked against its own dates and
      // correspondence (reviewGuard.js#guardByOrg).
      if (c.parties.length && Array.isArray(c.ai_review.by_org)) {
        const tracks = tracksForReview(c);
        const mine = contact.get(r.id) || new Map();
        c.ai_review.by_org = guardByOrg(c.ai_review.by_org, tracks, (k) => mine.get(k) || {}).map((e) => (
          e?.email ? { ...e, email_step: isStage2Request(e.email) ? 'stage2_request' : null } : e));
        c.ai_review = composeByOrg(c.ai_review, tracks);
      }
    }
    return c;
  });
}

// Every open part of the complaint is past Stage 1: a Stage 2 request is
// no longer something to send.
export function stage2Asked(tracks) {
  const open = tracks.filter((t) => t.stage && trackOpen(t));
  return open.length > 0 && open.every((t) => t.stage !== 'stage_1');
}

// The further organisations on a complaint, and what the list, the digest and
// the page need to know about all of them together: whether ANY organisation
// needs chasing, and every name and reference on it.
function withParties(c, parties) {
  const all = { ...c, parties };
  return {
    ...all,
    org_names: [c.org_name, ...parties.map((p) => p.org_name)],
    any_needs_chasing: Boolean(c.needs_chasing || parties.some((p) => p.needs_chasing)),
    // Organisations still running a part of it whose own procedure nobody
    // has found out (not researched, no document, nothing entered), so its
    // dates are the standard ones: typically set up by an import. Flagged on
    // the page, the list and the dashboard until they are researched.
    unresearched_orgs: [c, ...parties].filter((t) => t.procedure_missing && trackOpen(t)).map((t) => t.org_name),
    // The review is current when nothing it was written against has moved —
    // on any organisation's track.
    // With more than one organisation it must give each its own step
    // (by_org); one written before that is out of date.
    ai_review_current: Boolean(c.ai_review) && c.ai_review_status === reviewSignature(all) &&
      (!parties.length || Array.isArray(c.ai_review.by_org)),
  };
}

// The organisations a review speaks for, main first, each with its key.
export function tracksForReview(c) {
  return [{ ...c, key: 'main' }, ...(c.parties || []).map((p) => ({ ...p, key: p.id }))];
}

// One organisation's track worked out: status, rule, checklist and its
// complaints contact. The complaint row and a complaint_parties row both go
// through here, so the two can't be read differently.
function decorateTrack(t, org) {
  const rule = effectiveRule(org, t.org_type);
  return {
    ...t,
    ...deriveStatus(t, rule),
    rule,
    ack_due: computeAckDue(t, rule),
    ombudsman_from: computeOmbudsmanFrom(t, rule),
    steps: procedureSteps(t, rule),
    org_email: org?.complaints_email || null,
    org_complaints_url: org?.complaints_url || null,
    procedure: procedureOf(org),
    // Their own procedure isn't known yet: the dates are the standard ones.
    procedure_missing: !procedureOnFile(org),
  };
}

// What the deadlines rest on, so the page can say how far to trust them.
function procedureOf(org) {
  return org
    ? {
        organisation_id: org.id,
        name: org.name,
        procedure_ref: org.procedure_ref,
        procedure_summary: org.procedure_summary,
        sources: org.sources || [],
        evidence: org.procedure_evidence || {},
        research_status: org.research_status,
        verified_at: org.verified_at,
        verified_by: org.verified_by,
      }
    : null;
}

export function decorateWithOrg(c, org) {
  return { ...decorateTrack(c, org), email_address: complaintEmailAddress(c.ref_code) };
}

// A complaint's timeline, each entry saying which organisation's track it is
// on when that is not the main one.
export async function listEvents(id) {
  return (await query(
    `SELECT e.*, p.org_name AS party_name FROM complaint_events e
       LEFT JOIN complaint_parties p ON p.id = e.party_id
      WHERE e.complaint_id = $1 ORDER BY e.event_date DESC, e.created_at DESC`,
    [id],
  )).rows;
}

// Gather a complaint's full context (row + rule + timeline + emails + attachment
// text) for the AI endpoints. Throws 404 if the complaint doesn't exist.
export async function gatherContext(id, extraContext, { files } = {}) {
  const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Complaint not found');
  const complaint = await decorate(rows[0]);
  const events = await listEvents(id);
  const emails = await listComplaintEmails(id);
  const docs = await attachmentTexts(id);
  const docText = docs.length
    ? docs.map((a) => `--- Attached document: ${a.filename} ---\n${a.extracted_text}`).join('\n\n')
    : '';
  const merged = [extraContext, docText].filter(Boolean).join('\n\n');
  // PDFs and photos can't be turned into text here, so they go to the model
  // as documents in their own right — letters and statements are mostly PDFs.
  const blocks = await attachmentBlocks(id, files === undefined ? {} : { maxFiles: files, newest: true });
  return { complaint, rule: complaint.rule, events, emails, extraContext: merged, blocks };
}

