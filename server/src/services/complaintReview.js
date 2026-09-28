import { query } from '../db/pool.js';
import { config } from '../config.js';
import { gatherContext } from './complaintContext.js';
import { assistComplaint } from './complaintAssistant.js';
import { reviewSignature, normaliseNextAction } from './complaintRules.js';
import { guardReview, nextDueFromThem } from './reviewGuard.js';

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
  '5 Oct: wait for their Stage 1 answer."). No reasons in it; the reasons go in "summary". ' +
  'In "summary" (2-3 short sentences): where ' +
  'it stands, what the organisation most recently said (with its date), and whether they are keeping ' +
  'to the timescales of their procedure — naming any deadline they have missed. In ' +
  '"recommended_action": the single next thing Greenco should do, and by when. In "steps": the next ' +
  'few steps in order. In "email": the email for that next step, complete from greeting to sign-off ' +
  'so it can be pasted as a reply in their existing email thread as it stands — or, if nothing needs ' +
  'sending yet, the email to send if they miss their next deadline. Add "email_now": true if it ' +
  'should be sent now, false if it is only kept ready. Use the facts and dates in the context only. ALSO add a key "next_action": ' +
  '{"type": one of "send_email" (the draft should go now), "escalate_stage2", "refer_ombudsman", ' +
  '"record_acknowledgement" or "record_response" (an email or document on file shows they have, but ' +
  'it is not recorded), "resolve", "wait" (nothing to do until a date), "by": "YYYY-MM-DD" or null}. ' +
  'Recommend escalate/refer only when their procedure allows it now. ' +
  'BEFORE recommending anything, look at what Greenco has most recently done — its latest emails and ' +
  'the "Chased / sent" [chased] entries on the timeline. If Greenco has already done the step you ' +
  'would recommend (sent the chaser, asked for Stage 2, sent what they asked for), do NOT recommend it ' +
  'again: the next step is to wait for their reply, so say so in "headline" with the date to wait ' +
  'until (a reasonable reply date, or their procedure\'s deadline), set next_action to "wait", and ' +
  'make "email" the follow-up to send only if they don\'t reply by then, with "email_now": false.';

export async function refreshReview(id) {
  if (!config.anthropic.enabled) return null;
  // The two newest files only: the rest were read by earlier reviews, and
  // re-sending every PDF on every refresh is where the AI cost went.
  const ctx = await gatherContext(id, undefined, { files: 2 });
  try {
    const raw = await assistComplaint({ ...ctx, instruction: REVIEW_INSTRUCTION });
    const headline = typeof raw.headline === 'string' && raw.headline.trim()
      ? raw.headline.trim().replace(/\s+/g, ' ').slice(0, 200)
      : null;
    // Checked against the system's own dates: never "chase" what isn't due,
    // or chase again straight after writing to them (reviewGuard.js).
    const c = ctx.complaint;
    const londonDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const sent = [
      ...(ctx.events || []).filter((e) => e.type === 'chased').map((e) => e.event_date),
      ...(ctx.emails || []).filter((e) => e.direction === 'outbound' && e.received_at).map((e) => londonDay(e.received_at)),
    ].filter(Boolean).sort();
    const review = guardReview(
      { ...raw, headline, next_action: normaliseNextAction(raw.next_action) },
      {
        anyOverdue: Boolean(c.any_needs_chasing),
        nextDue: nextDueFromThem([c, ...(c.parties || [])]),
        lastSentOn: sent[sent.length - 1] || null,
      },
    );
    await query(
      `UPDATE complaints SET ai_review = $2, ai_reviewed_at = now(), ai_review_status = $3,
              ai_review_error = NULL WHERE id = $1`,
      [id, JSON.stringify(review), reviewSignature(ctx.complaint)],
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
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      refreshReview(id).catch((err) => console.error(`[complaints] review ${id} failed:`, err.message));
    }, delayMs),
  );
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
    if (row.ai_review && row.ai_review_status === reviewSignature(c)) continue;
    try {
      await refreshReview(row.id);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}
