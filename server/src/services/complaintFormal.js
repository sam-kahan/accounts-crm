// Starting a complaint from the day the complaint itself was sent: the
// formal complaint made from the page (sent from here, or recorded as sent
// from Outlook), a complaint logged before it was sent (not_sent_yet), and
// the copy of that complaint arriving from Outlook (complaintEmailProcessor).
import { query } from '../db/pool.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { scheduleReview } from './complaintReview.js';
import { ukDate } from './complaintRules.js';

// Also the FIRST email of a complaint logged before it was sent to them
// (`not_sent_yet`, awaitingFirstEmail): the same draft and send, and the
// complaint then runs from the day it went.
export async function startFormalComplaint(id, sentOn, by, { subject = null, fromHere = false, how = null } = {}) {
  const before = (await query('SELECT raised_on, stage, complaint_doubt, not_sent_yet FROM complaints WHERE id = $1', [id])).rows[0];
  if (!before) return false;
  const first = Boolean(before.not_sent_yet);
  // Only while the question is still open (or, for a complaint logged before
  // it was sent, while nothing has happened on it and it was never made from
  // here), in the same statement that answers it, so two at once (a send and
  // a record from Outlook) can't both start it: the second would wipe the
  // dates recorded after the first.
  const r = await query(
    `UPDATE complaints
        SET raised_on = $2, stage = 'stage_1', stage_started_on = $2, acknowledged_on = NULL,
            responded_on = NULL, final_response_on = NULL, response_due_manual = false,
            channel = 'email', complaint_doubt = NULL, not_sent_yet = false
      WHERE id = $1 AND (
        (complaint_doubt->>'kind' = 'not_complaint'
          AND COALESCE((complaint_doubt->>'answered')::boolean, false) = false)
        OR (not_sent_yet AND state = 'open' AND stage = 'stage_1' AND acknowledged_on IS NULL
          AND responded_on IS NULL AND final_response_on IS NULL))
      RETURNING id`,
    [id, sentOn],
  );
  if (!r.rows[0]) return false;
  await recomputeDeadlines(id);
  await query(
    `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'raised',$3,$4)`,
    [id, sentOn,
      `Formal complaint made${subject ? ` ("${subject}")` : ''}, ${how || (fromHere ? 'sent from here' : 'sent from Outlook')}. ` +
      (first
        ? `Its deadlines, and when it can go to the ombudsman, run from ${ukDate(sentOn)}` +
          (before.raised_on && String(before.raised_on) !== sentOn ? ` (it was logged here on ${ukDate(before.raised_on)}, before it was sent).` : '.')
        : `Its deadlines, and when it can go to the ombudsman, now run from ${ukDate(sentOn)}; the earlier emails are the background ` +
          `that led to it (it had been recorded as made on ${ukDate(before.raised_on)}, at ${String(before.stage).replace('_', ' ')}).`),
      by],
  );
  scheduleReview(id);
  return true;
}

