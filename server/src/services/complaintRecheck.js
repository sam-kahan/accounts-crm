import { query, pool } from '../db/pool.js';
import { config } from '../config.js';
import { todayISO, londonDateOf } from '../lib/dates.js';
import { ukDate, trackOpen } from './complaintRules.js';
import { overallState } from './complaintParties.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { reconstructComplaint } from './complaintReconstruct.js';
import { cleanAccountNumbers, dropDigitSlips, slipNote, searchComplaintEmails, withSearchLock, searchRunning } from './accountNumbers.js';
import { getSetting, setSetting } from './settings.js';

// ---------------------------------------------------------------------------
// Re-checking complaints against their emails (migration 031).
//
// Complaints imported from past emails were mostly left at Stage 1. For each
// open complaint the re-check:
//   1. searches the mailboxes for every account number and reference on it,
//      bringing any email that quotes one onto the complaint (no AI);
//   2. reads all its emails together, oldest first (one AI read — the same
//      reader the import uses — and none at all when nothing has arrived
//      since it was last re-checked);
//   3. moves it to where the emails show it has got to.
// planRecheck() decides step 3 and is pure and tested. It is deliberately
// cautious, because these are records people rely on:
//   - a stage only ever moves FORWARD; an earlier stage in the emails is
//     reported, not applied;
//   - a blank date is filled; a recorded date that differs is reported,
//     never overwritten;
//   - a low-confidence reading changes nothing;
//   - a complaint with more than one organisation isn't changed (one reading
//     of the emails can't say which organisation's procedure each step
//     belongs to); its reading is reported for a person.
// Whatever it changes is written on the timeline with the old and new
// values, can be undone exactly, and marks the complaint "To check".
// ---------------------------------------------------------------------------

export const RECHECK_BY = 'Re-check (read from the emails)';
const ORDER = { stage_1: 1, stage_2: 2, ombudsman: 3 };
const LABEL = { stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'the ombudsman', resolved: 'resolved' };
const DATE_LABEL = {
  acknowledged_on: 'acknowledged', responded_on: 'responded', final_response_on: 'final response',
  stage_started_on: 'stage started', closed_on: 'resolved on',
};

// What the emails' reading `x` (normaliseReconstruction's shape) changes on
// complaint `c`. Returns { changes, notes, differs, skip }:
//   changes  column → new value, to store
//   notes    plain-English list of what changed
//   differs  what the emails say that wasn't applied, for a person to check
//   skip     why nothing was applied at all, or null
export function planRecheck(c, x, { hasParties = false, today = todayISO() } = {}) {
  const changes = {};
  const notes = [];
  const differs = [];
  let doubt = null;
  const out = (skip = null) => ({ changes, notes, differs, skip, doubt });
  if (!x) return out('The emails could not be read');
  if (x.is_complaint === false) {
    doubt = { kind: 'not_complaint', why: x.not_complaint_why || 'no email shows a formal complaint being made' };
    return out('The emails don’t show a formal complaint being made');
  }

  // What the emails show, whatever happens to it.
  const said = `emails show ${x.state === 'resolved' ? 'it resolved' : LABEL[x.stage]}` +
    `${x.stage_started_on && x.stage !== 'stage_1' ? ` from ${ukDate(x.stage_started_on)}` : ''}`;
  if (x.confidence === 'low') {
    differs.push(`The AI wasn’t confident reading the emails (${said}), so nothing was changed`);
    return out('Low-confidence reading');
  }
  // The day it was made: every deadline and the ombudsman date run from it,
  // so a difference is put to a person whatever else happens below (a
  // complaint with more than one organisation included).
  if (x.raised_on && c.raised_on && x.raised_on !== c.raised_on) {
    differs.push(`It is recorded as made on ${ukDate(c.raised_on)}, the emails say ${ukDate(x.raised_on)}`);
    doubt = { kind: 'raised_date', date: x.raised_on, quote: x.complaint_evidence?.quote || null,
      why: `the emails show the complaint was made on ${ukDate(x.raised_on)}, but it is recorded as ${ukDate(c.raised_on)}` };
  }
  if (hasParties) {
    differs.push(`This complaint has more than one organisation, so its stages are set by hand (${said})`);
    return out('More than one organisation');
  }
  if (!trackOpen(c)) return out('Already resolved or closed');

  // A date from the emails is only usable if it could have happened: on or
  // after the complaint was made, and not in the future.
  const usable = (k) => {
    const v = x[k];
    if (!v) return null;
    if (v > today) return null;
    if (c.raised_on && v < c.raised_on) {
      differs.push(`The emails give ${DATE_LABEL[k] || k} as ${ukDate(v)}, before the complaint was made (${ukDate(c.raised_on)}); not used`);
      return null;
    }
    return v;
  };
  const fill = (k, v) => {
    if (!v) return;
    if (!c[k]) {
      changes[k] = v;
      notes.push(`${DATE_LABEL[k]}: ${ukDate(v)}`);
    } else if (c[k] !== v) {
      differs.push(`${DATE_LABEL[k]} is recorded as ${ukDate(c[k])}, the emails say ${ukDate(v)}`);
    }
  };

  // Resolved, clearly: the complaint's part is closed with its outcome.
  if (x.state === 'resolved') {
    const on = usable('resolved_on');
    if (x.confidence === 'high' && on) {
      changes.stage = 'resolved';
      changes.closed_on = on;
      if (x.outcome && !c.outcome) changes.outcome = x.outcome;
      notes.push(`resolved on ${ukDate(on)}${x.outcome ? ` (${x.outcome})` : ''}`);
      fill('acknowledged_on', usable('acknowledged_on'));
      fill('final_response_on', usable('final_response_on'));
      return out();
    }
    differs.push(`The emails suggest it was resolved${on ? ` on ${ukDate(on)}` : ''}${x.outcome ? ` (${x.outcome})` : ''}; mark it resolved if so`);
  }

  const now = ORDER[c.stage] || 1;
  const then = ORDER[x.stage] || 1;
  if (then > now) {
    // Moved on: the new stage, and when it began.
    changes.stage = x.stage;
    const started = usable('stage_started_on');
    changes.stage_started_on = started;
    // The response at the NEW stage (the old stage's answer isn't this one's).
    changes.responded_on = usable('responded_on');
    // Leaving Stage 2: their Stage 2 answer is their FINAL response (the
    // referral window counts from it), so it is kept as that rather than lost.
    if (c.stage === 'stage_2' && c.responded_on && !c.final_response_on && !x.final_response_on) {
      changes.final_response_on = c.responded_on;
      notes.push(`final response: ${ukDate(c.responded_on)} (their Stage 2 answer)`);
    }
    // With no start date there is no honest due date: none is stored until
    // someone enters it (as an import does).
    changes.response_due_manual = !started;
    if (!started) changes.response_due = null;
    notes.push(`${LABEL[c.stage] || c.stage} → ${LABEL[x.stage]}` +
      (started ? ` (from ${ukDate(started)})` : ' (the date it moved on isn’t in the emails: enter it with Edit details)'));
    if (changes.responded_on) notes.push(`responded: ${ukDate(changes.responded_on)}`);
    if (c.responded_on && x.stage === 'stage_2' && c.stage === 'stage_1') {
      notes.push(`their Stage 1 response (${ukDate(c.responded_on)}) is kept on the timeline`);
    }
  } else {
    if (then < now) differs.push(`It is recorded at ${LABEL[c.stage]}, but the emails only show ${LABEL[x.stage]}`);
    if (then === now) {
      if (c.stage !== 'stage_1') fill('stage_started_on', usable('stage_started_on'));
      fill('responded_on', usable('responded_on'));
    }
  }
  fill('acknowledged_on', usable('acknowledged_on'));
  fill('final_response_on', usable('final_response_on'));

  if (x.reference && !c.reference) {
    changes.reference = x.reference;
    notes.push(`their reference: ${x.reference}`);
  }
  return out();
}

// The emails a complaint's reading rests on: how many and the newest. When
// neither has changed since the last re-check, reading them again would give
// the same answer and cost the same again.
async function emailSignature(id) {
  const r = (await query(
    `SELECT count(*)::int AS n, max(received_at) AS latest FROM complaint_emails WHERE complaint_id = $1`, [id],
  )).rows[0];
  return `${r.n}:${r.latest ? new Date(r.latest).toISOString() : ''}`;
}

// An organisation taken off the complaint (complaints.removed_orgs): its
// emails are history, never read as the remaining organisation's steps —
// those tagged as its, and any from (or, ours, only to) its addresses.
export function offEmail(e, removed = [], ourDomain = '') {
  if (e.removed_org) return true;
  const domains = new Set(removed.flatMap((r) => r?.domains || []));
  if (!domains.size) return false;
  const ours = String(ourDomain || '').toLowerCase();
  const dom = (a) => (String(a || '').toLowerCase().match(/@([a-z0-9.-]+)/) || [])[1] || null;
  const sender = dom(e.sender_email);
  if (sender && sender !== ours) return domains.has(sender);
  const outside = (e.to_addresses || []).map(dom).filter((d) => d && d !== ours);
  return outside.length > 0 && outside.every((d) => domains.has(d));
}

async function emailsOf(id) {
  const c = (await query('SELECT removed_orgs FROM complaints WHERE id = $1', [id])).rows[0];
  return (await query(
    `SELECT id, message_id, graph_id, subject, sender_name, sender_email, to_addresses, body_text, body_preview, received_at, removed_org
       FROM complaint_emails WHERE complaint_id = $1 ORDER BY received_at`, [id],
  )).rows.filter((e) => !offEmail(e, c?.removed_orgs || [], config.complaintEmail.domain)).map((e) => ({
    id: e.id, messageId: e.message_id, graphId: e.graph_id, subject: e.subject, senderName: e.sender_name,
    senderEmail: e.sender_email, toAddresses: e.to_addresses || [], bodyText: e.body_text,
    bodyPreview: e.body_preview, receivedAt: e.received_at,
  }));
}

// `step` says what it is doing, for the page following a re-check (no-op
// for the run over every complaint).
const quiet = async () => {};
async function search(c, by, step = quiet, opts = { all: true }) {
  if (!config.ms.enabled) return { added: 0 };
  // Only one email search runs at a time; the background one (after each
  // 5-minute check, and at start-up) can take several minutes.
  if (searchRunning()) await step('Waiting for another email search to finish first');
  return withSearchLock(async () => {
    await step('Searching your mailboxes for its account numbers and references');
    return searchComplaintEmails(c, { ...opts, by });
  });
}

// Re-check one complaint. Returns what happened, for the run's report.
// Write the complaint's AI review now (the page's one-press re-check). A
// failure is put on the timeline rather than lost.
async function reviewNow(id, by, step = quiet) {
  const { refreshReview, cancelScheduledReview } = await import('./complaintReview.js');
  cancelScheduledReview(id); // e.g. one queued by the email search
  await step('Writing the next steps (AI review)');
  try {
    await refreshReview(id);
  } catch (err) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [id, todayISO(), `The AI review couldn’t be updated after the re-check: ${String(err.message).slice(0, 300)}. Press Refresh on the review to try again.`, by],
    );
  }
  cancelScheduledReview(id);
}

// `review: 'now'` (the complaint page's button): the AI review is written
// straight after, whatever changed, so one press gives the stage AND the next
// steps. Otherwise (the run over every complaint) it is refreshed only when
// something moved.
export async function recheckComplaint(id, { by = RECHECK_BY, force = false, review = 'if_changed', step = quiet } = {}) {
  let c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  if (!c) return { id, result: 'failed', text: 'No longer exists' };
  const brief = { id, ref_code: c.ref_code, subject: c.subject, org_name: c.org_name };

  // 1. Every email quoting its numbers (no AI).
  const s1 = await search(c, by, step);

  // 2. Nothing new since the last re-check: not read again.
  let sig = await emailSignature(id);
  if (!force && c.rechecked_at && c.recheck_signature === sig) {
    return { ...brief, result: 'skipped', text: 'Nothing new since it was last re-checked' };
  }
  let msgs = await emailsOf(id);
  if (!msgs.length) {
    await query('UPDATE complaints SET rechecked_at = now(), recheck_signature = $2 WHERE id = $1', [id, sig]);
    if (review === 'now') await reviewNow(id, by, step);
    return { ...brief, result: 'unchanged', text: 'No emails on file to read' };
  }
  await step(`Reading its ${msgs.length} email${msgs.length === 1 ? '' : 's'}`);
  let x = await reconstructComplaint(msgs);

  // Account numbers the emails give that weren't on file: kept, and searched
  // for too. If that finds more emails, they are read once more with the rest.
  // A number that is one on file with a digit missing (or the other way
  // round) is the same account mistyped: the full one is kept, never both.
  const known = new Set((c.account_numbers || []).map((a) => a.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const read = cleanAccountNumbers(x.account_numbers).filter((a) => !known.has(a.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const { kept, removed } = dropDigitSlips([...(c.account_numbers || []), ...read]);
  const accounts = kept.slice(0, 6);
  const fresh = read.filter((a) => accounts.includes(a));
  const dropped = removed.filter((r) => (c.account_numbers || []).includes(r.value));
  if (dropped.length) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [id, todayISO(), slipNote(dropped), by],
    );
  }
  let added = s1.added || 0;
  if (dropped.length && !fresh.length) {
    await query('UPDATE complaints SET account_numbers = $2 WHERE id = $1', [id, accounts]);
    c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  }
  if (fresh.length) {
    await query('UPDATE complaints SET account_numbers = $2 WHERE id = $1', [id, accounts]);
    c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
    const s2 = await search(c, by, step, {});
    added += s2.added || 0;
    if (s2.added) {
      msgs = await emailsOf(id);
      await step(`Reading its ${msgs.length} emails, with the ones just found`);
      x = await reconstructComplaint(msgs);
    }
  }

  // 3. Where the emails show it has got to. Planned inside the transaction
  // against the row as it is NOW, locked: the search and the read take a
  // minute or two, and a date recorded meanwhile (by a person, or by an email
  // arriving) must not be overwritten or recorded as "blank" for Undo.
  sig = await emailSignature(id);
  let plan;
  let cols = [];
  let text = '';
  const found = added ? `${added} more email${added === 1 ? '' : 's'} found and filed. ` : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new Error('The complaint was removed while it was being re-checked');
    const hasParties = (await client.query('SELECT 1 FROM complaint_parties WHERE complaint_id = $1 LIMIT 1', [id])).rowCount > 0;
    plan = planRecheck(cur, x, { hasParties });
    cols = Object.keys(plan.changes);
    const before = {};
    for (const k of cols) before[k] = cur[k] ?? null;
    // The deadlines worked out from those values, so Undo can put back a due
    // date that had been typed in by hand (recalculating won't recreate it).
    const beforeDeadlines = { response_due: cur.response_due ?? null, ombudsman_deadline: cur.ombudsman_deadline ?? null };
    text =
      `${found}Read ${msgs.length} email${msgs.length === 1 ? '' : 's'} (${x.confidence} confidence). ` +
      (cols.length ? `Changed: ${plan.notes.join('; ')}.` : plan.skip ? `Not changed: ${plan.skip}.` : 'Already right.') +
      (plan.differs.length ? ` Please check: ${plan.differs.join('; ')}.` : '') +
      (x.uncertain?.length ? ` Unclear in the emails: ${x.uncertain.slice(0, 4).join('; ')}.` : '');
    // Every email it read has now been taken into account, so none of them
    // is left sitting as "new" for a person to review. Not when it couldn't
    // act (low confidence, more than one organisation): then those emails
    // still need a person's reading.
    let readIds = [];
    if (!plan.skip) {
      readIds = (await client.query(
        `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = 'correspondence', reviewed_by = $3
          WHERE complaint_id = $1 AND id = ANY($2::uuid[]) AND reviewed_at IS NULL AND direction <> 'outbound'
          RETURNING id`,
        [id, msgs.map((m) => m.id), `${by} (read with all its emails)`],
      )).rows.map((r) => r.id);
      if (readIds.length) text += ` ${readIds.length} new email${readIds.length === 1 ? '' : 's'} read and marked as dealt with.`;
    }
    const flag = cols.length > 0 || plan.differs.length > 0;
    // The change, its timeline entry and its Undo record: all or nothing, so a
    // change is never left standing without the record that undoes it.
    if (cols.length) {
      const set = cols.map((k, i2) => `${k} = $${i2 + 2}`).join(', ');
      await client.query(`UPDATE complaints SET ${set} WHERE id = $1`, [id, ...cols.map((k) => plan.changes[k])]);
      // Open while any organisation's part is (a resolved main part with no
      // other organisation closes the complaint).
      const now = (await client.query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
      const parties = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [id])).rows;
      const state = overallState(now, parties);
      if (state !== now.state) {
        before.state = now.state;
        plan.changes.state = state;
        await client.query('UPDATE complaints SET state = $2 WHERE id = $1', [id, state]);
      }
      await recomputeDeadlines(id, client);
    }
    const ev = await client.query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,'note',$3,$4) RETURNING id`,
      [id, todayISO(), `Re-checked against its emails. ${text}`, by],
    );
    // A doubt a person has already answered ("it is a complaint", "keep the
    // recorded date") is not raised again by reading the same thing.
    const prior = cur.complaint_doubt;
    const answeredSame = prior?.answered && plan.doubt && prior.kind === plan.doubt.kind && (prior.date || null) === (plan.doubt.date || null);
    // A question still waiting for a person is never dropped by a re-check
    // that couldn't read the emails fully (low confidence, unreadable): only a
    // full reading that finds nothing wrong clears it.
    const couldNotJudge = !x || x.confidence === 'low';
    const doubtValue = answeredSame ? JSON.stringify(prior)
      : plan.doubt ? JSON.stringify({ ...plan.doubt, at: new Date().toISOString() })
        : couldNotJudge && prior && !prior.answered ? JSON.stringify(prior) : null;
    await client.query(
      `UPDATE complaints SET rechecked_at = now(), recheck_signature = $2,
              last_recheck = COALESCE($3::jsonb, last_recheck), needs_check = needs_check OR $4,
              complaint_doubt = $5::jsonb
        WHERE id = $1`,
      [
        id, sig,
        cols.length
          ? JSON.stringify({
            at: new Date().toISOString(), by, before, after: plan.changes,
            before_deadlines: beforeDeadlines, event_id: ev.rows[0].id, reviewed_emails: readIds,
          })
          : null,
        flag || Boolean(plan.doubt),
        doubtValue,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Its standing review is refreshed only when something moved (an AI call
  // each; the owner watches the bill).
  if (review === 'now') await reviewNow(id, by, step);
  else if (cols.length || added) {
    const { scheduleReview } = await import('./complaintReview.js');
    scheduleReview(id);
  }
  return { ...brief, result: cols.length ? 'changed' : 'unchanged', text, check: plan.differs.length > 0 };
}

// --- The complaint page's one-press re-check --------------------------------
// In the background (a long history takes longer than a browser waits), with
// where it has got to kept in complaints.recheck_progress (migration 040):
// running with its step, then done, failed or interrupted. The page follows
// that, so it always learns how the re-check ended, whatever happened.
const runningHere = new Set();
// When this server started: only a re-check begun before it can have been cut off.
const serverStarted = new Date().toISOString();

async function setProgress(id, fields) {
  await query(
    `UPDATE complaints SET recheck_progress = COALESCE(recheck_progress, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(fields)],
  );
}

// The progress as the page should see it: "running" is only true while this
// server is doing it; one left running by a server that stopped is shown as
// interrupted (start-up records it properly: settleInterruptedRechecks).
export function recheckProgressOf(c) {
  const p = c?.recheck_progress;
  if (p?.status === 'running' && !runningHere.has(c.id)) return { ...p, status: 'interrupted' };
  return p || null;
}

// Claimed before anything is awaited, so two presses can't start two.
export async function startComplaintRecheck(id, by) {
  if (runningHere.has(id)) {
    const e = new Error('This complaint is already being re-checked.');
    e.status = 409;
    throw e;
  }
  runningHere.add(id);
  try {
    await query('UPDATE complaints SET recheck_progress = $2 WHERE id = $1', [
      id,
      JSON.stringify({ status: 'running', step: 'Starting', started_at: new Date().toISOString(), by }),
    ]);
  } catch (err) {
    runningHere.delete(id);
    throw err;
  }
  (async () => {
    try {
      await recheckComplaint(id, { by, force: true, review: 'now', step: (step) => setProgress(id, { step }) });
      await setProgress(id, { status: 'done', step: null, finished_at: new Date().toISOString() });
    } catch (err) {
      console.error(`[complaints] re-check ${id} failed:`, err.message);
      const why = String(err.message).slice(0, 300);
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [id, todayISO(), `Re-check against its emails failed: ${why}. Nothing was changed.`, by],
      ).catch(() => {});
      await setProgress(id, { status: 'failed', error: why, finished_at: new Date().toISOString() }).catch(() => {});
    } finally {
      runningHere.delete(id);
    }
  })();
}

// At start-up: a re-check the restart cut off (a deploy restarts the server)
// is marked interrupted, with a timeline note saying how far it got, so
// neither the page nor anyone reading the complaint later is left guessing.
// The stage and dates are changed in one transaction, so they either were
// (it had reached the next steps) or weren't at all.
export async function settleInterruptedRechecks() {
  const { rows } = await query(
    `UPDATE complaints
        SET recheck_progress = recheck_progress || jsonb_build_object('status', 'interrupted', 'finished_at', now())
      WHERE recheck_progress->>'status' = 'running'
        AND COALESCE((recheck_progress->>'started_at')::timestamptz, '-infinity') < $1::timestamptz
      RETURNING id, recheck_progress->>'step' AS step, recheck_progress->>'by' AS by`,
    [serverStarted],
  );
  for (const r of rows) {
    const reviewing = /^Writing the next steps/.test(r.step || '');
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [
        r.id, todayISO(),
        reviewing
          ? 'The re-check was cut off by a server restart while it was writing the next steps. Its stage and dates had already been re-checked; press Refresh on the AI review for the next steps.'
          : `The re-check was cut off by a server restart before it finished (it was at: ${String(r.step || 'starting').toLowerCase()}), so it changed nothing. Press Re-check & update next steps again.`,
        r.by || RECHECK_BY,
      ],
    );
  }
  return rows.length;
}

// Undo what the last re-check changed on a complaint — only while every value
// is still as it left it (a date someone has since corrected is never wiped).
export async function undoRecheck(id, by) {
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  const r = c?.last_recheck;
  if (!r?.after) {
    const e = new Error('The last re-check didn’t change anything.');
    e.status = 400;
    throw e;
  }
  const cols = Object.keys(r.before || {});
  const moved = cols.filter((k) => (c[k] ?? null) !== (r.after[k] ?? null));
  if (moved.length) {
    const e = new Error(`Can’t undo: ${moved.map((k) => k.replace(/_/g, ' ')).join(', ')} has been changed since. Use Edit details instead.`);
    e.status = 409;
    throw e;
  }
  if (cols.length) {
    const set = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(`UPDATE complaints SET ${set} WHERE id = $1`, [id, ...cols.map((k) => r.before[k])]);
  }
  // A due date typed in by hand before the re-check comes back as it was
  // (recalculating below leaves a hand-typed date alone, so it must be put
  // back here).
  if (r.before?.response_due_manual === true && r.before_deadlines && !('response_due' in (r.before || {}))) {
    await query('UPDATE complaints SET response_due = $2 WHERE id = $1', [id, r.before_deadlines.response_due]);
  }
  await query(
    `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
    [id, todayISO(), `Changes from the re-check on ${londonDateOf(new Date(r.at))} undone (${cols.map((k) => `${k.replace(/_/g, ' ')} back to ${r.before[k] ?? 'blank'}`).join('; ')}).`, by],
  );
  // The emails it marked as dealt with are new again: what they said is no
  // longer recorded, so a person should see them.
  if (Array.isArray(r.reviewed_emails) && r.reviewed_emails.length) {
    await query(
      `UPDATE complaint_emails SET reviewed_at = NULL, reviewed_as = NULL, reviewed_by = NULL
        WHERE complaint_id = $1 AND id = ANY($2::uuid[]) AND reviewed_by LIKE '%(read with all its emails)'`,
      [id, r.reviewed_emails],
    );
  }
  await query('UPDATE complaints SET last_recheck = NULL WHERE id = $1', [id]);
  await recomputeDeadlines(id);
  const { scheduleReview } = await import('./complaintReview.js');
  scheduleReview(id);
}

// --- The run over every open complaint --------------------------------------
// In the background, one complaint at a time (each is a search and an AI
// read), with its progress and every result kept in app_settings.recheck_run
// for the page. Only ever started by a person pressing the button.
let running = false;

export async function recheckStatus() {
  const s = (await getSetting('recheck_run')) || null;
  if (s && s.status === 'running' && !running) return { ...s, status: 'interrupted' };
  return s;
}

export async function startRecheck({ by, force = false }) {
  if (!config.anthropic.enabled) {
    const e = new Error('The AI isn’t configured (ANTHROPIC_API_KEY), so the emails can’t be read.');
    e.status = 503;
    throw e;
  }
  if (running) {
    const e = new Error('A re-check is already running.');
    e.status = 409;
    throw e;
  }
  // Claimed before anything is awaited: two presses at once (two people, two
  // tabs) must not start two runs that each pay to read every complaint.
  running = true;
  let ids;
  let state;
  try {
    ids = (await query(
      `SELECT id FROM complaints WHERE state = 'open' ORDER BY imported DESC, raised_on`,
    )).rows.map((r) => r.id);
    state = {
      status: 'running', by: by || null, started_at: new Date().toISOString(), finished_at: null,
      total: ids.length, done: 0, changed: 0, skipped: 0, failed: 0, to_check: 0, results: [],
      mailbox_searched: config.ms.enabled,
    };
    await setSetting('recheck_run', state, by);
  } catch (err) {
    running = false;
    throw err;
  }
  (async () => {
    try {
      for (const id of ids) {
        let r;
        try {
          r = await recheckComplaint(id, { by: RECHECK_BY, force });
        } catch (err) {
          r = { id, result: 'failed', text: String(err.message).slice(0, 300) };
        }
        state.done += 1;
        if (r.result === 'changed') state.changed += 1;
        if (r.result === 'skipped') state.skipped += 1;
        if (r.result === 'failed') state.failed += 1;
        if (r.check) state.to_check += 1;
        state.results.push(r);
        await setSetting('recheck_run', state, by).catch(() => {});
      }
      state.status = 'finished';
    } catch (err) {
      state.status = 'failed';
      state.error = String(err.message).slice(0, 300);
    } finally {
      state.finished_at = new Date().toISOString();
      running = false;
      await setSetting('recheck_run', state, by).catch(() => {});
    }
  })();
  return state;
}
