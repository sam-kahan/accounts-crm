import { query } from '../db/pool.js';
import { config } from '../config.js';
import { gatherContext } from './complaintContext.js';
import { assistComplaint } from './complaintAssistant.js';
import { reviewSignature, normaliseNextAction } from './complaintRules.js';

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
  'Write the standing review of this complaint as it is TODAY. In "summary" (3-5 sentences): where ' +
  'it stands, what the organisation most recently said (with its date), and whether they are keeping ' +
  'to the timescales of their procedure — naming any deadline they have missed. In ' +
  '"recommended_action": the single next thing Greenco should do, and by when. In "steps": the next ' +
  'few steps in order. In "email": the email for that next step, ready to check and send — or, if ' +
  'nothing needs sending yet, the email to send if they miss their next deadline, and say so in ' +
  '"caution". Use the facts and dates in the context only. ALSO add a key "next_action": ' +
  '{"type": one of "send_email" (the draft should go now), "escalate_stage2", "refer_ombudsman", ' +
  '"record_acknowledgement" or "record_response" (an email or document on file shows they have, but ' +
  'it is not recorded), "resolve", "wait" (nothing to do until a date), "by": "YYYY-MM-DD" or null}. ' +
  'Recommend escalate/refer only when their procedure allows it now.';

export async function refreshReview(id) {
  if (!config.anthropic.enabled) return null;
  const ctx = await gatherContext(id);
  try {
    const raw = await assistComplaint({ ...ctx, instruction: REVIEW_INSTRUCTION });
    const review = { ...raw, next_action: normaliseNextAction(raw.next_action) };
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

// Fire-and-forget refresh after a change. Several changes in quick succession
// (an email with three attachments, say) collapse into one review.
const pending = new Map();
export function scheduleReview(id, delayMs = 4000) {
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
