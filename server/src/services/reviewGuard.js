import { todayISO } from '../lib/dates.js';
import { addWorkingDays, ukDate, trackOpen } from './complaintRules.js';

// ---------------------------------------------------------------------------
// The AI review must never tell anyone to chase what isn't due, or to chase
// again straight after chasing. The system works the deadlines out itself
// (complaintRules.js), so those dates — not the model's reading — decide.
// guardReview() checks a review against them and, where it recommends chasing
// against them, replaces the advice with what the dates say: wait, and until
// when. Pure and tested.
// ---------------------------------------------------------------------------

// A reply is given this long after we have chased before chasing again.
export const CHASE_GAP_WORKING_DAYS = 5;

const CHASE_WORDS =
  /\b(chase|chaser|chasing|overdue|missed|late|follow[- ]?up|remind(er)?|nudge|still (not|waiting|no)|not (yet )?(been )?(acknowledged|received|responded|answered)|no (reply|response|acknowledgement))\b/i;

// Does a review tell Greenco to chase / follow up now?
export function recommendsChasing(r) {
  if (!r) return false;
  if (r.next_action?.type === 'wait') return false;
  const said = [r.headline, r.recommended_action, r.email?.subject].filter(Boolean).join(' ');
  return CHASE_WORDS.test(said);
}

// The next thing due FROM THEM across every organisation's open track: the
// acknowledgement or the response, whichever comes first.
export function nextDueFromThem(tracks) {
  const due = [];
  for (const t of tracks) {
    if (!trackOpen(t)) continue;
    const who = tracks.length > 1 ? `${t.org_name}'s` : 'their';
    if (t.status === 'awaiting_ack' && t.ack_due) due.push({ date: t.ack_due, what: `${who} acknowledgement` });
    else if (t.status === 'awaiting_response' && t.response_due) {
      due.push({ date: t.response_due, what: `${who} ${t.stage === 'stage_2' ? 'final (Stage 2)' : 'Stage 1'} response` });
    }
  }
  return due.sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

// facts: { anyOverdue, nextDue: {date, what} | null, lastSentOn: 'YYYY-MM-DD' | null, today }
// Returns the review unchanged, or corrected with `guarded` saying why.
export function guardReview(review, facts) {
  if (!review || !recommendsChasing(review)) return review;
  const today = facts.today || todayISO();
  let headline = null;
  let by = null;
  let why = null;
  const sentLately = facts.lastSentOn &&
    workingDaysSince(facts.lastSentOn, today) < CHASE_GAP_WORKING_DAYS;
  if (sentLately) {
    by = addWorkingDays(facts.lastSentOn, CHASE_GAP_WORKING_DAYS);
    if (facts.nextDue && facts.nextDue.date > by) by = facts.nextDue.date;
    headline = `Nothing to send yet: you last wrote to them on ${ukDate(facts.lastSentOn)}. Wait for their reply until ${ukDate(by)}.`;
    why = `It suggested chasing, but Greenco wrote to them on ${ukDate(facts.lastSentOn)}, so a reply is given until ${ukDate(by)} first.`;
  } else if (!facts.anyOverdue) {
    by = facts.nextDue?.date || null;
    headline = facts.nextDue
      ? `Nothing to send yet: wait for ${facts.nextDue.what}, due ${ukDate(facts.nextDue.date)}.`
      : 'Nothing to send yet: nothing is overdue, so wait for their reply.';
    why = facts.nextDue
      ? `It suggested chasing, but nothing is overdue: ${facts.nextDue.what} is not due until ${ukDate(facts.nextDue.date)}.`
      : 'It suggested chasing, but nothing is overdue by their procedure.';
  } else {
    return review; // something really is overdue and nothing was sent lately: chasing is right
  }
  return {
    ...review,
    headline,
    recommended_action: headline,
    next_action: { type: 'wait', by },
    email_now: false,
    caution: [review.caution, `${why} The drafted email is kept for if they miss that date.`].filter(Boolean).join(' '),
    guarded: why,
  };
}

// Working days from `from` to `to` (0 on the same day).
function workingDaysSince(from, to) {
  if (from >= to) return 0;
  // workingDaysUntil counts from today; count directly instead.
  let n = 0;
  let d = from;
  while (d < to && n < 60) {
    d = addWorkingDays(d, 1);
    if (d <= to) n += 1;
  }
  return n;
}
