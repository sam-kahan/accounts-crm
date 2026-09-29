import { query } from '../db/pool.js';
import { config } from '../config.js';
import { ensureSignOff } from '../lib/signature.js';
import { gatherContext, lastTheirsByComplaint, stage2Asked, tracksForReview, anyReferral } from './complaintContext.js';
import { contactForOne } from './trackContact.js';
import { assistComplaint } from './complaintAssistant.js';
import { reviewSignature, normaliseNextAction, reviewOutrun } from './complaintRules.js';
import { todayISO } from '../lib/dates.js';
import { guardReview, nextDueFromThem, guardByOrg, normaliseByOrg, composeByOrg } from './reviewGuard.js';

export { reviewSignature };

// ---------------------------------------------------------------------------
// The assistant's standing review of each complaint: where it stands, what the
// organisation last said, whether they are keeping to their procedure, the next
// step, and a draft email for it. Kept up to date by itself — refreshed after
// anything changes (an email, a document, a recorded step, a correction) and
// nightly when the calendar alone has moved a complaint on (an acknowledgement
// going overdue). Nothing is ever sent from here; the draft waits for a person.
// ---------------------------------------------------------------------------

const REVIEW_INSTRUCTION =
  'Write the standing review of this complaint as it is TODAY. FIRST add a key "headline": ONE short ' +
  'plain-English instruction, at most 15 words, starting with a verb, saying exactly what to do next ' +
  'and by when (e.g. "Email E.ON Next asking for the final bill by 8 Oct." or "Nothing to do until ' +
  '5 Oct: wait for their Stage 1 answer."). It must say what TO do: never only what not to do ("Do not ' +
  'escalate." on its own tells nobody anything). No reasons in it; the reasons go in "summary". ' +
  'The complaint has ALREADY been made (see the context): never recommend "raising" or "making" a complaint, ' +
  'and never draft an email that raises one or threatens one. ' +
  'In "summary" (2-3 short sentences): where ' +
  'it stands, what the organisation most recently said (with its date), and whether they are keeping ' +
  'to the timescales of their procedure — naming any deadline they have missed. In ' +
  '"recommended_action": the single next thing Greenco should do, and by when. In "steps": the next ' +
  'few steps in order. In "email": the email for that next step (short and natural: see how the emails read), complete from greeting to sign-off ' +
  'so it can be pasted as a reply in their existing email thread as it stands — or, if nothing needs ' +
  'sending yet, the email to send if they miss their next deadline. Add "email_now": true if it ' +
  'should be sent now, false if it is only kept ready. Use the facts and dates in the context only. ALSO add a key "next_action": ' +
  '{"type": one of "send_email" (the draft should go now), "escalate_stage2", "refer_ombudsman", ' +
  '"record_acknowledgement" or "record_response" (an email or document on file shows they have, but ' +
  'it is not recorded), "resolve", "wait" (nothing to do until a date), "by": "YYYY-MM-DD" or null}. ' +
  'Recommend escalate/refer only when their procedure allows it now. ' +
  'ALSO add a key "supplier": when the complaint is against a debt collector, collections solicitor or ' +
  'anyone else pursuing a bill ON BEHALF OF another company (the supplier or creditor that owns the ' +
  'debt, e.g. LCS collecting for British Gas), and that company is NOT already one of the organisations ' +
  'on this complaint, give {"name": the supplier as named in the emails, "why": one sentence on why the ' +
  'complaint should be raised with them too}; otherwise null. ' +
  'BEFORE recommending anything, look at what Greenco has most recently done — its latest emails and ' +
  'the "Chased / sent" [chased] entries on the timeline. If Greenco has already done the step you ' +
  'would recommend (sent the chaser, asked for Stage 2, sent what they asked for), do NOT recommend it ' +
  'again: the next step is to wait for their reply, so say so in "headline" with the date to wait ' +
  'until (a reasonable reply date, or their procedure\'s deadline), set next_action to "wait", and ' +
  'make "email" the follow-up to send only if they don\'t reply by then, with "email_now": false. ' +
  'Once a complaint (or an organisation\'s part of it) is at Stage 2 or with the ombudsman, Stage 2 has ' +
  'already been asked for: never draft the Stage 2 request again; any follow-up asks for their Stage 2 ' +
  'response by its due date.';

// A complaint against more than one organisation (a debt collector and the
// council or supplier whose account it is): separate complaints, each with
// its own procedure, deadlines and correspondence, so separate next steps.
const BY_ORG_INSTRUCTION =
  ' THIS COMPLAINT IS AGAINST MORE THAN ONE ORGANISATION (the main one and the further ones in the ' +
  'context). Each is a SEPARATE complaint with its own procedure, deadlines and emails: an email sent to ' +
  'one is not a step with another, and one organisation\'s deadline never applies to another. ALSO add ' +
  '"by_org": an array with ONE entry per organisation, the main organisation first, each {"org": its name ' +
  'exactly as in the context, "headline", "email", "email_now", "next_action"} following all the rules ' +
  'above but about THAT organisation only: its own stage and deadlines and the emails to and from it. ' +
  'Each "email" is addressed to that organisation only and is about its part only. The top-level ' +
  '"headline" then says in a few words what to do with each (e.g. "CDER: ask for Stage 2 now. Council: ' +
  'wait for their acknowledgement, due 2 Oct.").';

export async function refreshReview(id) {
  if (!config.anthropic.enabled) return null;
  const startedAt = new Date();
  // The two newest files only: the rest were read by earlier reviews, and
  // re-sending every PDF on every refresh is where the AI cost went.
  const ctx = await gatherContext(id, undefined, { files: 2 });
  try {
    const multi = (ctx.complaint.parties || []).length > 0;
    const raw = await assistComplaint({ ...ctx, feature: 'Standing AI review (automatic)', instruction: REVIEW_INSTRUCTION + (multi ? BY_ORG_INSTRUCTION : '') });
    // Every drafted email ends with the sign-off the sender's details go into.
    if (raw?.email?.body) raw.email = { ...raw.email, body: ensureSignOff(raw.email.body) };
    if (Array.isArray(raw?.by_org)) raw.by_org = raw.by_org.map((e) => (e?.email?.body ? { ...e, email: { ...e.email, body: ensureSignOff(e.email.body) } } : e));
    const headline = typeof raw.headline === 'string' && raw.headline.trim()
      ? raw.headline.trim().replace(/\s+/g, ' ').slice(0, 200)
      : null;
    // Checked against the system's own dates: never "chase" what isn't due,
    // or chase again straight after writing to them (reviewGuard.js).
    const c = ctx.complaint;
    const londonDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const sent = [
      ...(ctx.events || []).filter((e) => e.type === 'chased' && !e.removed_org).map((e) => e.event_date),
      ...(ctx.emails || []).filter((e) => e.direction === 'outbound' && e.received_at && !e.removed_org).map((e) => londonDay(e.received_at)),
    ].filter(Boolean).sort();
    // The company a debt collector is acting for, to raise it with too.
    const supplier = raw.supplier && typeof raw.supplier.name === 'string' && raw.supplier.name.trim()
      ? { name: raw.supplier.name.trim().slice(0, 200), why: typeof raw.supplier.why === 'string' ? raw.supplier.why.trim().slice(0, 400) : null }
      : null;
    let review = guardReview(
      { ...raw, headline, supplier, next_action: normaliseNextAction(raw.next_action) },
      {
        referral: (c.parties || []).length ? anyReferral([c, ...c.parties]) : c.referral,
        anyOverdue: Boolean(c.any_needs_chasing),
        nextDue: nextDueFromThem([c, ...(c.parties || [])]),
        lastSentOn: sent[sent.length - 1] || null,
        lastTheirsOn: (await lastTheirsByComplaint([id])).get(id) || null,
        stage2Asked: stage2Asked([c, ...(c.parties || [])]),
      },
    );
    // Each organisation's own step, checked against its own dates and emails.
    if (multi) {
      const tracks = tracksForReview(c);
      const contact = await contactForOne(id, config.complaintEmail.domain);
      review.by_org = guardByOrg(normaliseByOrg(raw.by_org, tracks), tracks, (k) => contact.get(k) || {});
      review = composeByOrg(review, tracks);
    }
    // Whether each organisation's part could go to the ombudsman when this
    // was written: when that changes the review is out of date
    // (complaintRules.js#reviewOutrun).
    review.referral_open = [c, ...(c.parties || [])].map((t) => Boolean(t.referral?.open));
    await query(
      `UPDATE complaints SET ai_review = $2, ai_reviewed_at = now(), ai_review_status = $3,
              ai_review_error = NULL,
              -- A change asked for a review while this one was being written: kept, so it follows.
              review_wanted_at = CASE WHEN review_wanted_at <= $4 THEN NULL ELSE review_wanted_at END
        WHERE id = $1`,
      [id, JSON.stringify(review), reviewSignature(ctx.complaint), startedAt],
    );
    return review;
  } catch (err) {
    await query('UPDATE complaints SET ai_review_error = $2 WHERE id = $1', [id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

// Fire-and-forget refresh after a change. Every change within a couple of
// minutes (an import, the emails found for it, their attachments) collapses
// into ONE review, rather than one per change.
const pending = new Map();

// A review is being written now, so one already queued for this complaint
// would only repeat it (and be paid for twice).
export function cancelScheduledReview(id) {
  clearTimeout(pending.get(id));
  pending.delete(id);
}

export function scheduleReview(id, delayMs = 120000) {
  if (!config.anthropic.enabled || !id) return;
  // Kept on the complaint as well as in the timer: a restart (every deploy)
  // within the two minutes would otherwise lose it, and a change that moves
  // no date leaves nothing for the nightly check to notice.
  query('UPDATE complaints SET review_wanted_at = now() WHERE id = $1', [id]).catch(() => {});
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      refreshReview(id).catch((err) => console.error(`[complaints] review ${id} failed:`, err.message));
    }, delayMs),
  );
}

// At start-up: the reviews asked for but not written before the server
// stopped, one each (spaced out), so none is lost to a deploy.
export async function resumeWantedReviews() {
  if (!config.anthropic.enabled) return 0;
  const { rows } = await query(
    `SELECT id FROM complaints WHERE review_wanted_at IS NOT NULL
        AND (ai_reviewed_at IS NULL OR review_wanted_at > ai_reviewed_at) ORDER BY review_wanted_at`,
  );
  rows.forEach((r, i) => scheduleReview(r.id, 120000 + i * 15000));
  return rows.length;
}

// Nightly: refresh every open complaint whose review the calendar has
// overtaken, or that has never had one. Capped, and best-effort — the digest
// must go out regardless.
export async function refreshStaleReviews({ limit = 25 } = {}) {
  if (!config.anthropic.enabled) return { skipped: 'AI not configured' };
  const { decorate } = await import('./complaintContext.js');
  const { rows } = await query(`SELECT * FROM complaints WHERE state = 'open' ORDER BY raised_on`);
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    if (refreshed + failed >= limit) break;
    const c = await decorate(row);
    // Current, and (with more than one organisation) giving each its own step.
    if (row.ai_review && row.ai_review_status === reviewSignature(c) &&
      (!(c.parties || []).length || Array.isArray(row.ai_review.by_org)) &&
      !reviewOutrun(row.ai_review, [c, ...(c.parties || [])], todayISO())) continue;
    try {
      await refreshReview(row.id);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}
