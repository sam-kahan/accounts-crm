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

// A headline that says not to SEND anything ("Don't chase", "Nothing to send",
// "No action needed", "Wait…"): the email that came with it is the one kept
// ready for later, never one to send now.
const HOLD_WORDS =
  /^\s*((do not|don['’]t|no need to) (send|chase|email|write|contact|reply|follow)|nothing\b|no action|no further action|not yet\b|wait\b|hold\b)/i;
export function saysHold(r) {
  return HOLD_WORDS.test(r?.headline || '');
}

// A headline that only says what NOT to do about something else ("Do not
// escalate.") and nothing about what to do instead.
function onlyNegative(h) {
  const t = String(h || '').trim();
  return /^(do not|don['’]t|no need to)\b/i.test(t) && !/\b(send|email|reply|wait|until|due|instead|ask|chase)\b/i.test(t);
}

// Does a review tell Greenco to send an email NOW (whatever it is about)?
export function wantsToSendNow(r) {
  if (!r) return false;
  if (r.next_action?.type === 'wait' || r.email_now === false || saysHold(r)) return false;
  return r.next_action?.type === 'send_email' || Boolean(r.email?.body) || recommendsChasing(r);
}

// facts: { anyOverdue, nextDue: {date, what} | null, lastSentOn, lastTheirsOn, today }
//   lastSentOn    the last day Greenco wrote to them (an email sent, a chaser logged)
//   lastTheirsOn  the last day an email arrived FROM them
// Returns the review unchanged, or corrected with `guarded` saying why.
export function guardReview(review, facts) {
  if (!review) return review;
  const today = facts.today || todayISO();
  // "Do not escalate." says what not to do and nothing about what to do. It
  // is made whole from the review's own next action: the email below, when
  // there is one to send (the ball rule further down still applies), or
  // waiting, with what for and until when.
  if (onlyNegative(review.headline) && !saysHold(review)) {
    const base = review.headline.replace(/[.\s]*$/, '');
    const sendIt = review.email?.body && review.email_now !== false && review.next_action?.type !== 'wait';
    if (sendIt) {
      const h = `${base} yet. Send the email below${review.email.subject ? `: “${review.email.subject}”` : ''}.`;
      review = { ...review, headline: h, recommended_action: h };
    } else {
      const h = `${base}. Nothing to send now: ${facts.nextDue ? `wait for ${facts.nextDue.what}, due ${ukDate(facts.nextDue.date)}` : 'wait for their reply'}.`;
      return {
        ...review, headline: h, recommended_action: h, email_now: false,
        next_action: { type: 'wait', by: review.next_action?.by || facts.nextDue?.date || null },
      };
    }
  }
  if (saysHold(review)) {
    const bare = !/\b(wait|until|due|by \w+ \d|nothing to send)\b/i.test(review.headline);
    const tail = facts.nextDue
      ? ` Nothing to send now: wait for ${facts.nextDue.what}, due ${ukDate(facts.nextDue.date)}.`
      : ' Nothing to send now: wait for their reply.';
    const headline = bare ? `${review.headline.replace(/[.\s]*$/, '.')}${tail}` : review.headline;
    return {
      ...review,
      headline,
      recommended_action: bare ? headline : review.recommended_action,
      next_action: { type: 'wait', by: review.next_action?.by || facts.nextDue?.date || null },
      email_now: false,
    };
  }
  let headline = null;
  let by = null;
  let why = null;
  // The ball is in their court: Greenco wrote last. Nothing more is sent —
  // whatever the email would be about — until they have had a fair time to
  // reply (and their own deadline, if later), however the advice is worded.
  const ballTheirs = facts.lastSentOn && (!facts.lastTheirsOn || facts.lastSentOn >= facts.lastTheirsOn);
  if (ballTheirs && wantsToSendNow(review)) {
    let until = addWorkingDays(facts.lastSentOn, CHASE_GAP_WORKING_DAYS);
    if (facts.nextDue && facts.nextDue.date > until) until = facts.nextDue.date;
    if (today < until) {
      return corrected(review, {
        by: until,
        headline: `Nothing more to send: you wrote to them on ${ukDate(facts.lastSentOn)}. Wait for their reply until ${ukDate(until)}.`,
        why: `It suggested sending an email, but Greenco wrote to them on ${ukDate(facts.lastSentOn)} and they haven't replied since, so they have until ${ukDate(until)} first.`,
      });
    }
  }
  if (!recommendsChasing(review)) return review;
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
  return corrected(review, { headline, by, why });
}

function corrected(review, { headline, by, why }) {
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
