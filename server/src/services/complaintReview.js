import { query } from '../db/pool.js';
import { config } from '../config.js';
import { ensureSignOff } from '../lib/signature.js';
import { gatherContext, lastTheirsByComplaint, stage2Asked, tracksForReview, anyReferral } from './complaintContext.js';
import { contactForOne } from './trackContact.js';
import { assistComplaint, prepareAssist, finishAssist, anthropicClient } from './complaintAssistant.js';
import { getSetting, setSetting } from './settings.js';
import { recordUsage } from './aiUsage.js';
import { reviewSignature, normaliseNextAction, reviewOutrun } from './complaintRules.js';
import { todayISO } from '../lib/dates.js';
import { guardReview, nextDueFromThem, guardByOrg, normaliseByOrg, composeByOrg } from './reviewGuard.js';
import { withRequestedDocs } from './draftChecks.js';
import { referenceLines, withReferences } from '../lib/references.js';

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
  'ALSO add a key "supplier": ONLY when the complaint is against a debt collector or collections ' +
  'solicitor pursuing a bill ON BEHALF OF another company (the supplier or creditor that owns the ' +
  'debt, e.g. LCS collecting for British Gas), and that company is NOT already one of the organisations ' +
  'on this complaint, give {"name": the supplier as named in the emails, "why": one sentence on why the ' +
  'complaint should be raised with them too}; otherwise null. Never for a managing agent acting for a ' +
  'freeholder or landlord: Greenco deals with the agent. ' +
  // Facts a person noted (a call, what another company told us) are what
  // Greenco knows: used where they bear on the email, and said whose they are.
  'Notes Greenco people added to the timeline are facts Greenco knows (a phone call, something another ' +
  'company or the landlord told them): use each one where it bears on the next step or the email, and say ' +
  'where it came from ("Urban Bubble have told us that…"), never as more certain than the note says. ' +
  'BEFORE recommending anything, look at what Greenco has most recently done — its latest emails and ' +
  'the "Chased / sent" [chased] entries on the timeline. If Greenco has already done the step you ' +
  'would recommend (sent the chaser, asked for Stage 2, sent what they asked for), do NOT recommend it ' +
  'again: the next step is to wait for their reply, so say so in "headline" with the date to wait ' +
  'until (a reasonable reply date, or their procedure\'s deadline), set next_action to "wait", and ' +
  'make "email" the follow-up to send only if they don\'t reply by then, with "email_now": false. ' +
  'Once a complaint (or an organisation\'s part of it) is at Stage 2 or with the ombudsman, Stage 2 has ' +
  'already been asked for: never draft the Stage 2 request again; any follow-up asks for their Stage 2 ' +
  'response by its due date. ' +
  // What they have asked US for: matched to the documents on file, so the
  // email goes with them, and the page asks a person for anything missing.
  'ALSO add a key "requested": when the organisation\'s latest email asks Greenco for documents or ' +
  'information (proof of ownership, a tenancy agreement, meter readings, a letter of authority, the ' +
  'landlord\'s details, an account number…), list EACH thing asked for as {"item": what they asked for, ' +
  'in a few words, "file": the exact file name from DOCUMENTS ON FILE that provides it, judged by its ' +
  'description, or null; "given": where Greenco has ALREADY given it, e.g. "our email of 23 September ' +
  '2026" (information counts as given when it is written in one of Greenco\'s emails, before or after ' +
  'their request: read Greenco\'s emails for it), or null; "not_ours": when it is not Greenco\'s to ' +
  'give, one short reason (e.g. "Greenco no longer manages the property and holds no tenant details"), ' +
  'or null}; otherwise null. Name a file only when it really is that thing (a council tax bill is not a ' +
  'tenancy agreement); when unsure, null. An item already given, or not Greenco\'s to give, is never ' +
  'asked for again: the email repeats what was given (quoting it), says when it was first given, and says ' +
  'plainly what Greenco does not hold. Sending the reply is a step to take NOW ("next_action" ' +
  '"send_email", "email_now": true) unless Greenco has already answered it: the email puts every file ' +
  'named in "requested" in "email.attach"; for anything with no file it never says it is attached. ' +
  'Only when something is genuinely missing (no file, not given, and Greenco\'s to give) does the ' +
  '"headline" say so first, e.g. "Upload the tenancy agreement, then email EDF the documents they asked ' +
  'for today."';

// A complaint against more than one organisation (a debt collector and the
// council or supplier whose account it is): separate complaints, each with
// its own procedure, deadlines and correspondence, so separate next steps.
const BY_ORG_INSTRUCTION =
  ' THIS COMPLAINT IS AGAINST MORE THAN ONE ORGANISATION (the main one and the further ones in the ' +
  'context). Each is a SEPARATE complaint with its own procedure, deadlines and emails: an email sent to ' +
  'one is not a step with another, and one organisation\'s deadline never applies to another. ALSO add ' +
  '"by_org": an array with ONE entry per organisation, the main organisation first, each {"org": its name ' +
  'exactly as in the context, "headline", "email", "email_now", "next_action", "requested"} following all the rules ' +
  'above but about THAT organisation only: its own stage and deadlines and the emails to and from it. ' +
  'Each "email" is addressed to that organisation only and is about its part only. The top-level ' +
  '"headline" then says in a few words what to do with each (e.g. "CDER: ask for Stage 2 now. Council: ' +
  'wait for their acknowledgement, due 2 Oct.").';

// Has Greenco said not to raise it with this organisation? Names compared
// loosely ("Emerald GR Trustee 2 Ltd" is "Emerald GR Trustee 2 Limited").
const nameKey = (n) => String(n || '').toLowerCase().replace(/\b(limited|ltd|plc|llp|the)\b/g, '').replace(/[^a-z0-9]/g, '');
export function declinedSupplier(name, declined = []) {
  const k = nameKey(name);
  return Boolean(k) && (declined || []).some((d) => {
    const x = nameKey(d);
    return x && (x === k || x.includes(k) || k.includes(x));
  });
}

// A review in three parts, so the overnight batch (below) and a direct
// refresh do exactly the same thing: prepare the request, ask, apply.
async function prepareReview(id, feature) {
  const startedAt = new Date();
  // Only files that arrived since the last review (the two newest of them):
  // one on file before it is known by its label from then on, rather than
  // paid for again on every refresh (attachments.js#attachmentBlocks).
  const last = (await query('SELECT ai_reviewed_at FROM complaints WHERE id = $1', [id])).rows[0]?.ai_reviewed_at || null;
  const ctx = await gatherContext(id, undefined, { files: 2, since: last });
  const multi = (ctx.complaint.parties || []).length > 0;
  const input = { ...ctx, feature, instruction: REVIEW_INSTRUCTION + (multi ? BY_ORG_INSTRUCTION : '') };
  return { id, ctx, input, startedAt, signature: reviewSignature(ctx.complaint) };
}

// The model's reading made into the stored review: sign-off, documents,
// references, and every guard against the system's own dates. Returns the
// review, or null when a later one was already saved.
async function applyReview({ id, ctx, startedAt, signature }, raw) {
  const multi = (ctx.complaint.parties || []).length > 0;
  // Every drafted email ends with the sign-off the sender's details go into.
  if (raw?.email?.body) raw.email = { ...raw.email, body: ensureSignOff(raw.email.body) };
  if (Array.isArray(raw?.by_org)) raw.by_org = raw.by_org.map((e) => (e?.email?.body ? { ...e, email: { ...e.email, body: ensureSignOff(e.email.body) } } : e));
  // What they asked for, matched to the documents on file; those found go
  // with the email (draftChecks.js#withRequestedDocs).
  Object.assign(raw, withRequestedDocs(raw, ctx.docList || []));
  if (Array.isArray(raw.by_org)) raw.by_org = raw.by_org.map((e) => withRequestedDocs(e, ctx.docList || []));
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
  // Only with a debt collector on the complaint (the debt is the supplier's),
  // and never one Greenco has said not to raise it with ("Not needed").
  const collector = [c, ...(c.parties || [])].some((t) => t.org_type === 'debt_collector');
  const supplier = collector && raw.supplier && typeof raw.supplier.name === 'string' && raw.supplier.name.trim() &&
    !declinedSupplier(raw.supplier.name, c.supplier_declined)
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
    // Each email quotes its organisation's reference as "Your reference"
    // and every other one by name (lib/references.js), whatever the AI wrote.
    review.by_org = review.by_org.map((e) => (e?.email?.body
      ? { ...e, email: { ...e.email, body: withReferences(e.email.body, referenceLines(tracks, e.key)) } } : e));
    review = composeByOrg(review, tracks);
  } else if (review.email?.body) {
    review.email = { ...review.email, body: withReferences(review.email.body, referenceLines(tracksForReview(c), 'main')) };
  }
  // Whether each organisation's part could go to the ombudsman when this
  // was written: when that changes the review is out of date
  // (complaintRules.js#reviewOutrun).
  review.referral_open = [c, ...(c.parties || [])].map((t) => Boolean(t.referral?.open));
  // Dated when its reading was TAKEN (a document that arrived while it was
  // being written is new to the next one), and never over a review taken
  // later than it (a batch answer arriving after a direct review).
  const saved = await query(
    `UPDATE complaints SET ai_review = $2, ai_reviewed_at = $4, ai_review_status = $3,
            ai_review_error = NULL,
            -- A change asked for a review while this one was being written: kept, so it follows.
            review_wanted_at = CASE WHEN review_wanted_at <= $4 THEN NULL ELSE review_wanted_at END
      WHERE id = $1 AND (ai_reviewed_at IS NULL OR ai_reviewed_at <= $4)`,
    [id, JSON.stringify(review), signature, startedAt],
  );
  if (!saved.rowCount) return null;
  return review;
}

export async function refreshReview(id) {
  if (!config.anthropic.enabled) return null;
  const prep = await prepareReview(id, 'Standing AI review (automatic)');
  try {
    return await applyReview(prep, await assistComplaint(prep.input));
  } catch (err) {
    await query('UPDATE complaints SET ai_review_error = $2 WHERE id = $1', [id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

// Fire-and-forget refresh after a change. Every change within 10 minutes of
// the last (an email, its attachments, the step recorded from it, a reply
// sent, the emails an import brings in) collapses into ONE review rather
// than one each: every review is a full paid read of the complaint. A
// steady run of changes can't hold it off for ever: it is written at the
// latest 30 minutes after the first change it is waiting for. A person who
// needs it now presses for it (POST /:id/review), which cancels the wait.
export const REVIEW_WAIT_MS = 10 * 60 * 1000;
export const REVIEW_MAX_WAIT_MS = 30 * 60 * 1000;
const pending = new Map(); // id -> { timer, since }

// A review is being written now, so one already queued for this complaint
// would only repeat it (and be paid for twice).
export function cancelScheduledReview(id) {
  clearTimeout(pending.get(id)?.timer);
  pending.delete(id);
}

export function scheduleReview(id, delayMs = REVIEW_WAIT_MS) {
  if (!config.anthropic.enabled || !id) return;
  // Kept on the complaint as well as in the timer: a restart (every deploy)
  // within the wait would otherwise lose it, and a change that moves no
  // date leaves nothing for the nightly check to notice.
  query('UPDATE complaints SET review_wanted_at = now() WHERE id = $1', [id]).catch(() => {});
  const was = pending.get(id);
  clearTimeout(was?.timer);
  const since = was?.since || Date.now();
  const wait = Math.max(0, Math.min(delayMs, since + REVIEW_MAX_WAIT_MS - Date.now()));
  pending.set(id, {
    since,
    timer: setTimeout(() => {
      pending.delete(id);
      refreshReview(id).catch((err) => console.error(`[complaints] review ${id} failed:`, err.message));
    }, wait),
  });
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

// Every morning (the reminder run): the open complaints whose review the
// calendar has overtaken, or that never had one. Capped.
async function staleReviewIds(limit) {
  const { decorate } = await import('./complaintContext.js');
  const { rows } = await query(`SELECT * FROM complaints WHERE state = 'open' ORDER BY raised_on`);
  const ids = [];
  for (const row of rows) {
    if (ids.length >= limit) break;
    const c = await decorate(row);
    // Current, and (with more than one organisation) giving each its own step.
    if (row.ai_review && row.ai_review_status === reviewSignature(c) &&
      (!(c.parties || []).length || Array.isArray(row.ai_review.by_org)) &&
      !reviewOutrun(row.ai_review, [c, ...(c.parties || [])], todayISO())) continue;
    ids.push(row.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The morning's stale reviews go as ONE batch (Anthropic's Message Batches:
// half the price of the same requests sent one by one, answered usually
// within the hour). Nobody is waiting on them: they are the ones the calendar
// moved on overnight. Each request is exactly what a direct refresh sends
// (prepareReview + prepareAssist), and each answer is applied exactly as a
// direct one (finishAssist + applyReview). The batch is kept in
// app_settings.review_batch, so a restart picks it up again, and each
// 5-minute mailbox check collects it once it has ended. Nothing is lost: an
// answer that failed or expired falls back to a direct review, and one taken
// before a later direct review of the same complaint is not applied.
// ---------------------------------------------------------------------------
export const BATCH_FEATURE = 'Standing AI review (morning batch, half price)';

export async function refreshStaleReviews({ limit = 25 } = {}) {
  if (!config.anthropic.enabled) return { skipped: 'AI not configured' };
  const running = await getSetting('review_batch');
  if (running?.id && !running.done_at) return { skipped: 'the last batch is still being answered', batch: running.id };
  const ids = await staleReviewIds(limit);
  if (!ids.length) return { batched: 0 };
  const requests = [];
  const items = {};
  for (const id of ids) {
    try {
      const prep = await prepareReview(id, BATCH_FEATURE);
      const { params } = await prepareAssist(prep.input);
      requests.push({ custom_id: id, params });
      items[id] = { startedAt: prep.startedAt.toISOString(), signature: prep.signature };
    } catch (err) {
      console.error(`[complaints] review ${id} not batched:`, err.message);
    }
  }
  if (!requests.length) return { batched: 0 };
  try {
    const batch = await anthropicClient().messages.batches.create({ requests });
    await setSetting('review_batch', { id: batch.id, submitted_at: new Date().toISOString(), items }, 'morning reviews');
    return { batched: requests.length, batch: batch.id };
  } catch (err) {
    // The batch couldn't be sent: the reviews are written one by one as
    // before (full price), so the morning's steps are never left stale.
    console.error('[complaints] review batch not sent, reviewing directly:', err.message);
    let refreshed = 0;
    let failed = 0;
    for (const id of Object.keys(items)) {
      try { await refreshReview(id); refreshed += 1; } catch { failed += 1; }
    }
    return { refreshed, failed };
  }
}

let collecting = false;
export async function collectReviewBatch() {
  if (collecting || !config.anthropic.enabled) return null;
  collecting = true;
  try {
    const b = await getSetting('review_batch');
    if (!b?.id || b.done_at) return null;
    const client = anthropicClient();
    const status = await client.messages.batches.retrieve(b.id);
    if (status.processing_status !== 'ended') return { waiting: b.id };
    let applied = 0;
    let superseded = 0;
    const retry = [];
    for await (const r of await client.messages.batches.results(b.id)) {
      const item = b.items?.[r.custom_id];
      if (!item) continue;
      if (r.result?.type !== 'succeeded') { retry.push(r.custom_id); continue; }
      const message = r.result.message;
      // Recorded at the batch price (aiUsage.js#costOf halves a "(batch)" model).
      await recordUsage(BATCH_FEATURE, { ...message, model: `${message.model} (batch)` });
      try {
        if (message.stop_reason === 'refusal') throw new Error('The assistant declined this request.');
        const text = message.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        // The complaint as it is now, for the guards; the signature and the
        // time are the ones the request was taken at, so a change since
        // leaves it out of date and it is reviewed again.
        const prep = await prepareReview(r.custom_id, BATCH_FEATURE);
        const raw = await finishAssist(prep.input, text);
        const saved = await applyReview({ ...prep, startedAt: new Date(item.startedAt), signature: item.signature }, raw);
        if (saved) applied += 1; else superseded += 1;
      } catch (err) {
        console.error(`[complaints] batch review ${r.custom_id} not applied:`, err.message);
        retry.push(r.custom_id);
      }
    }
    // Failed, expired or unusable: a direct review instead, spaced out.
    retry.forEach((id, i) => scheduleReview(id, 60000 + i * 20000));
    await setSetting('review_batch', { ...b, done_at: new Date().toISOString(), applied, superseded, retried: retry.length }, 'morning reviews');
    return { applied, superseded, retried: retry.length };
  } finally {
    collecting = false;
  }
}
