import { plural } from '../lib/words.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { londonDateOf } from '../lib/dates.js';
import { searchMailbox, fetchConversation } from './graphMail.js';
import { parseImportedComplaint, triageComplaintThread } from './complaintAssistant.js';
import { reconstructComplaint, belongsToComplaint, cleanQuickReading } from './complaintReconstruct.js';
import { domainOf } from './mailWatch.js';
import { storeEmail } from './emailIngest.js';
import { getSetting, setSetting, mailboxAllowed } from './settings.js';
import { createComplaint } from './complaintCreate.js';
import { findOrgByName, groupCandidates, mergeExtracted, findExistingMatch, postcodeOf, sameIssue, PARTY_COLS } from './orgMatch.js';
import { processHistoricalEmail, processEmail } from './complaintEmailProcessor.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { scheduleReview } from './complaintReview.js';
import { ukDate } from './complaintRules.js';

// ---------------------------------------------------------------------------
// "Find past complaints": search the chosen mailboxes for complaint emails,
// group them into threads, have the AI read each thread, and list the ones
// that are complaints Greenco made — with who, what, when and how far they got
// — for a person to Import or Skip. Importing creates the complaint at its
// stage with its dates, and brings in every email in the thread with its
// attachments. Nothing is created without that click: old complaints may be
// long settled.
// Runs in the background (it can take a while); progress is in app_settings
// under 'past_scan' so the page can show it.
// ---------------------------------------------------------------------------

const PHRASES = [
  'formal complaint', 'complaint', 'stage 1', 'stage 2', 'final viewpoint', 'final response',
  'ombudsman', 'complaints procedure', 'deadlock',
];
// Per search. Most threads are ruled out before the full read (no email from
// us to an outside party, or a quick low-effort look), so this is generous; a
// second search carries on past it, as threads already read are skipped.
const MAX_THREADS = 2000;

let running = false;
const AUTO_SEARCH = 'Automatic (past-complaints search)';

// Serialises the steps that decide whether a complaint is already on file and
// then create or link it, so concurrent readers can't both create one.
let lock = Promise.resolve();
function serially(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function progress(patch) {
  const now = (await getSetting('past_scan')) || {};
  await setSetting('past_scan', { ...now, ...patch, updated_at: new Date().toISOString() });
}

export async function scanStatus() {
  return (await getSetting('past_scan')) || { status: 'never' };
}

export async function startScan({ mailboxes, months, by }) {
  if (!config.ms.enabled) throw Object.assign(new Error('The mailbox connection isn’t set up on the server.'), { status: 503 });
  if (!config.anthropic.enabled) throw Object.assign(new Error('The AI isn’t set up on the server.'), { status: 503 });
  if (running) throw Object.assign(new Error('A search is already running.'), { status: 409 });
  running = true;
  await setSetting('past_scan', {
    status: 'running', mailboxes, months, by, started_at: new Date().toISOString(),
    stage: 'Searching the mailboxes', threads: 0, read: 0, found: 0, skipped: 0, errors: [],
  });
  runScan({ mailboxes, months })
    .catch(async (err) => progress({ status: 'failed', error: err.message }))
    .finally(() => { running = false; });
}

function threadText(msgs) {
  return msgs
    .map((m) =>
      `--- Email ${londonDateOf(m.receivedAt)} from ${m.senderName || ''} <${m.senderEmail || ''}> ` +
      `to ${(m.toAddresses || []).join(', ')} — "${m.subject || ''}"\n` +
      String(m.bodyText || m.bodyPreview || '').slice(0, 6000))
    .join('\n\n')
    .slice(0, 30000);
}

// A complaint Greenco made has at least one email from Greenco to someone
// outside it. Threads without one (internal chat, newsletters, someone
// complaining TO us) are ruled out without being read by the AI at all.
export function couldBeOurComplaint(msgs, ourDomain) {
  return msgs.some((m) => {
    if (domainOf(m.senderEmail) !== ourDomain) return false;
    return (m.toAddresses || []).some((a) => {
      const d = domainOf(a);
      return d && d !== ourDomain;
    });
  });
}

// N months before now, clamped to the month's end: 31 May less 3 months is
// 28 Feb, never 3 Mar (Date#setMonth overflows), so no days go unsearched.
export function monthsAgo(n, now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

async function runScan({ mailboxes, months, carry = null }) {
  const cutoff = monthsAgo(months);
  // Only complaints still live are worth bringing in: every ombudsman we deal
  // with must be approached within 12 months (of the final response, or of
  // the problem), so a thread with nothing in the last year is left alone.
  const activeSince = monthsAgo(12);
  const errors = [];

  // 1. Search, and group into threads not already known.
  const known = new Set(
    (await query('SELECT conversation_id FROM complaint_emails WHERE conversation_id IS NOT NULL')).rows
      .map((r) => r.conversation_id),
  );
  // A thread already found (in any mailbox) isn't found again.
  const seen = new Set(
    (await query('SELECT conversation_id FROM complaint_import_candidates')).rows.map((r) => r.conversation_id),
  );
  // Microsoft returns at most 1,000 results per search, newest first, so the
  // period is searched three months at a time — otherwise a long history
  // would only ever show its most recent complaints.
  const windows = [];
  for (let end = new Date(); end > cutoff;) {
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    windows.push({ from: start < cutoff ? cutoff : start, to: new Date(end.getTime() + 86400000) });
    end = start;
  }
  const threads = new Map(); // conversationId -> { mailbox, conversationId }
  // Threads a search has already been through (read, listed, imported, skipped
  // or ruled out) are never read again: a new search reads only new threads.
  const alreadyRead = new Set();
  search: for (const mb of mailboxes) {
    for (const w of windows) {
      for (const phrase of PHRASES) {
        try {
          for (const m of await searchMailbox(mb, phrase, { from: w.from, to: w.to })) {
            if (!m.conversationId || m.receivedAt < cutoff) continue;
            if (known.has(m.conversationId) || seen.has(m.conversationId)) {
              alreadyRead.add(m.conversationId);
              continue;
            }
            if (!threads.has(m.conversationId)) {
              threads.set(m.conversationId, { mailbox: mb, conversationId: m.conversationId });
            }
          }
        } catch (err) {
          errors.push(`${mb} "${phrase}": ${err.message}`);
          if (err.status === 403 || err.status === 404) continue search; // no access to this mailbox
        }
        if (threads.size >= MAX_THREADS) break search;
      }
    }
  }
  const list = [...threads.values()].slice(0, MAX_THREADS);
  // Carrying on after a restart: the counts continue from where they were.
  const before = carry?.read || 0;
  await progress({ stage: 'Reading each email thread', threads: before + list.length, skipped: alreadyRead.size, errors });

  // 2. Read the threads, four at a time: each can mean waiting on the AI, and
  // reading them side by side is several times quicker for the same cost.
  let read = before;
  let found = carry?.found || 0;
  const readOne = async (t) => {
    try {
      const msgs = await fetchConversation(t.mailbox, t.conversationId);
      if (!msgs.length) return;
      // The same thread in another mailbox can carry a different thread id:
      // recognise it by its emails, and don't read or list it twice.
      const ids = msgs.map((m) => m.messageId).filter(Boolean);
      if (ids.length) {
        // Only an email filed ON a complaint counts: one merely stored (an
        // unfiled email) mustn't hide a complaint thread from the search.
        const dup = await query(
          `SELECT 1 FROM complaint_import_candidates WHERE message_ids && $1::text[]
           UNION ALL SELECT 1 FROM complaint_emails WHERE message_id = ANY($1::text[]) AND complaint_id IS NOT NULL LIMIT 1`,
          [ids],
        );
        if (dup.rows.length) {
          // Remembered, so the next search doesn't fetch it again.
          await query(
            `INSERT INTO complaint_import_candidates (mailbox, conversation_id, subject, message_count, status, message_ids, extracted)
             VALUES ($1,$2,$3,$4,'duplicate',$5,$6) ON CONFLICT (mailbox, conversation_id) DO NOTHING`,
            [t.mailbox, t.conversationId, msgs[0].subject, msgs.length, ids,
              JSON.stringify({ is_complaint: false, why: 'already listed or already on a complaint' })],
          );
          return;
        }
      }
      let extracted;
      const text = threadText(msgs);
      const lastAt = new Date(msgs[msgs.length - 1].receivedAt);
      if (lastAt < activeSince) {
        // Nothing has happened on it for a year: past every ombudsman's
        // referral window, so not worth reading. Remembered, never re-read.
        extracted = { is_complaint: false, why: 'no activity in the last 12 months' };
      } else if (!couldBeOurComplaint(msgs, config.complaintEmail.domain.toLowerCase())) {
        extracted = { is_complaint: false, why: 'no email from Greenco to an outside party' };
      } else if (!(await triageComplaintThread(text).catch(() => true))) {
        extracted = { is_complaint: false, why: 'quick look: not a complaint Greenco made' };
      } else {
        try {
          extracted = await parseImportedComplaint({
            text,
            hint: 'This is an email thread found in a Greenco mailbox. Decide first whether it is a complaint Greenco made.',
          });
        } catch (err) {
          // Read, but nothing usable came back: ruled out as before (reading
          // it again would cost the same for the same answer).
          if (err.status === 502) {
            extracted = { is_complaint: false, why: 'could not be read' };
          } else {
            // Not read at all (the AI busy, a dropped connection): nothing is
            // stored, so the next search reads it rather than ruling it out
            // for good.
            errors.push(`thread ${t.conversationId.slice(0, 12)}…: couldn't be read (${err.message}); the next search will try it again`);
            return;
          }
        }
        // The quick reading, clamped like the full one before it is kept:
        // it can stand in for the full reading on import.
        if (extracted.is_complaint !== false || extracted.subject) extracted = cleanQuickReading(extracted);
      }
      const isComplaint = extracted.is_complaint !== false && Boolean(extracted.subject);
      if (isComplaint) found += 1;
      await query(
        `INSERT INTO complaint_import_candidates
           (mailbox, conversation_id, graph_ids, subject, first_at, last_at, message_count, extracted, status, message_ids,
            accounts_read_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN now() END)
         ON CONFLICT (mailbox, conversation_id) DO NOTHING`,
        [
          t.mailbox, t.conversationId, msgs.map((m) => m.graphId), msgs[0].subject,
          msgs[0].receivedAt, msgs[msgs.length - 1].receivedAt, msgs.length,
          JSON.stringify(extracted), isComplaint ? 'pending' : 'not_complaint',
          msgs.map((m) => m.messageId).filter(Boolean),
          Array.isArray(extracted.account_numbers), // read with the rest by the full read
        ],
      );
      // Certain to be a complaint already in the system (same organisation,
      // same property postcode): its emails are added there straight away,
      // rather than waiting for someone to press Link.
      if (isComplaint) {
        // One at a time across the four readers: two threads about the same
        // issue must not both decide "not on file yet" and create it twice.
        await serially(async () => {
          const cand = (await query(
            `SELECT id FROM complaint_import_candidates WHERE mailbox = $1 AND conversation_id = $2 AND status = 'pending'`,
            [t.mailbox, t.conversationId],
          )).rows[0];
          if (!cand) return;
          const group = await groupOf(cand.id);
          if (await relatedImportRunning(group)) return; // picked up once that one is on file
          const { hit, certain } = await onFileFor(group);
          if (hit && certain) {
            await linkCandidate(cand.id, hit.id, AUTO_SEARCH);
            found -= 1; // not a new one to look at
          } else if (await getSetting('past_auto_import')) {
            // Switched on: imported as it is found by the same rule automatic
            // import follows (autoPlan: its account number read, the AI sure,
            // nothing skipped about it), marked "to check" like everything
            // the system creates itself.
            const plan = autoPlan(group, { hit, certain, paused: await importsPaused(), skipped: await relatedSkipped(group) });
            if (plan.due && plan.will === 'import') await importCandidate(group[0].id, AUTO_SEARCH);
          }
        }).catch((err) => {
          if (err.status !== 409) throw err; // someone pressed Import or Link first
        });
      }
    } catch (err) {
      errors.push(`thread ${t.conversationId.slice(0, 12)}…: ${err.message}`);
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const t = list[next];
      next += 1;
      await readOne(t);
      read += 1;
      if (read % 5 === 0 || read === before + list.length) await progress({ read, found, errors: errors.slice(-10) });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await progress({ status: 'done', stage: 'Finished', read, found, finished_at: new Date().toISOString(), errors: errors.slice(-10) });
}

// Import one found complaint: create it at its stage with its dates, then
// bring in the whole thread (read in full, attachments kept).
// The pending threads about the same issue as this one (itself included).
async function groupOf(id) {
  const pending = (await query(`SELECT * FROM complaint_import_candidates WHERE status = 'pending'`)).rows;
  return groupCandidates(pending).find((g) => g.some((c) => c.id === id)) || [];
}

// Other threads about the same complaint that the keyword search didn't find
// (an email about "Apt 78" with no complaint words in it). Searched by their
// reference and the property postcode, kept only if they involve the same
// organisation and a quick AI check says they belong.
async function gatherRelated(seed, mailboxes, knownConvs, orgDomains) {
  const phrases = [seed.reference, postcodeOf(seed.property)].filter(Boolean);
  if (!phrases.length || !orgDomains.size) return [];
  const onFile = new Set(
    (await query('SELECT DISTINCT conversation_id FROM complaint_emails WHERE conversation_id IS NOT NULL')).rows
      .map((r) => r.conversation_id),
  );
  const found = new Map();
  for (const mb of mailboxes) {
    for (const phrase of phrases) {
      try {
        for (const m of await searchMailbox(mb, phrase, { max: 200 })) {
          if (!m.conversationId || knownConvs.has(m.conversationId) || onFile.has(m.conversationId)) continue;
          const people = [m.senderEmail, ...(m.toAddresses || [])].map(domainOf);
          if (!people.some((d) => orgDomains.has(d))) continue;
          if (!found.has(m.conversationId)) found.set(m.conversationId, mb);
        }
      } catch {
        /* a search that fails just finds nothing more */
      }
      if (found.size >= 10) break;
    }
  }
  const summary = `Against ${seed.org_name}; ${seed.subject || ''}; property ${seed.property || 'unknown'}; ` +
    `their reference ${seed.reference || 'none'}. ${seed.summary || ''}`;
  const extra = [];
  for (const [conv, mb] of [...found].slice(0, 10)) {
    try {
      const msgs = (await fetchConversation(mb, conv)).map((m) => ({ ...m, mailbox: mb }));
      if (msgs.length && (await belongsToComplaint(summary, msgs))) extra.push(...msgs);
    } catch {
      /* skip a thread that can't be read */
    }
  }
  return extra;
}

// Import a found complaint as a complete record: every email about it — from
// every thread found with it, plus any others gathered by reference and
// postcode — read together, the complaint filled in from the whole story with
// its timeline rebuilt, and every email and attachment filed on it.
// What is already on file for a group of found threads, checked the way the
// list checks it: every thread and the merged record, not just one of them.
//   hit      the complaint it matches, if any
//   certain  the match is by the property itself (same organisation,
//            postcode and flat/house number), so its emails can be linked
//            without asking
export async function onFileFor(group, preloaded = null) {
  const complaints = preloaded?.complaints
    || (await query(`SELECT c.id, c.ref_code, c.subject, c.org_name, c.organisation_id, c.property, c.raised_on, c.reference, c.our_reference, c.account_numbers, ${PARTY_COLS} FROM complaints c`)).rows;
  const orgs = preloaded?.orgs || (await query('SELECT id, name FROM organisations')).rows;
  const xs = group.map((c) => c.extracted || {});
  if (group.length > 1) xs.push(mergeExtracted(group));
  // A certain match from any thread wins; otherwise the first possible one.
  const matches = xs.map((x) => findExistingMatch(complaints, orgs, x)).filter(Boolean);
  const best = matches.find((m) => m.certain) || matches[0] || null;
  const hit = best?.complaint || null;
  const certain = Boolean(best?.certain);
  return { hit, certain };
}

// A related import still running has no complaint on file yet, so nothing
// above can see it; this can. Rows being imported that are the same issue.
async function relatedImportRunning(group) {
  const busy = (await query(`SELECT extracted FROM complaint_import_candidates WHERE status = 'importing'`)).rows;
  return busy.some((b) => group.some((c) => sameIssue(c.extracted, b.extracted)));
}

// A thread about the same issue that a person skipped: automatic import
// leaves this one for a person too, rather than bringing back from a thread
// found later what they chose not to track.
export async function relatedSkipped(group, preloaded = null) {
  const skipped = preloaded || (await query(`SELECT extracted FROM complaint_import_candidates WHERE status = 'skipped'`)).rows;
  return skipped.some((s) => group.some((c) => sameIssue(c.extracted, s.extracted)));
}

// Claim a found complaint (and the threads grouped with it) for one import or
// link, so a second click, a second person, or automatic import can't bring it
// in twice. The claim is a single UPDATE ... WHERE status = 'pending': exactly
// one caller gets the rows. Returns the claimed group, or throws 409.
async function claimGroup(id, by) {
  const group = await groupOf(id);
  // The same issue being imported right now would be created twice.
  if (group.length && (await relatedImportRunning(group))) {
    throw Object.assign(new Error(
      'A related complaint is being imported right now. When it has finished, this one will show as already in the system, to link.',
    ), { status: 409 });
  }
  const ids = (group.length ? group : [{ id }]).map((c) => c.id);
  const { rows } = await query(
    `UPDATE complaint_import_candidates
        SET status = 'importing', error = NULL, decided_by = $2,
            import_attempts = import_attempts + 1, last_attempt_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'pending' RETURNING *`,
    [ids, by],
  );
  if (!rows.some((r) => r.id === id)) {
    // Someone else has it; hand back anything of the group this call did
    // take exactly as it was (its last error, who last acted on it, its tries),
    // so a refused claim changes nothing.
    for (const r of rows) {
      const before = group.find((g) => g.id === r.id) || {};
      await query(
        `UPDATE complaint_import_candidates
            SET status = 'pending', error = $2, decided_by = $3, import_attempts = $4, last_attempt_at = $5
          WHERE id = $1 AND status = 'importing'`,
        [r.id, before.error ?? null, before.decided_by ?? null, before.import_attempts ?? 0, before.last_attempt_at ?? null],
      );
    }
    const now = (await query('SELECT status FROM complaint_import_candidates WHERE id = $1', [id])).rows[0];
    if (!now) throw Object.assign(new Error('Not found'), { status: 404 });
    throw Object.assign(new Error(now.status === 'importing'
      ? 'This one is already being brought in.' : 'This one has already been dealt with.'), { status: 409 });
  }
  return rows.sort((a, b) => new Date(a.first_at) - new Date(b.first_at));
}

async function releaseGroup(ids, error = null) {
  await query(
    `UPDATE complaint_import_candidates SET status = 'pending', error = $2
      WHERE id = ANY($1::uuid[]) AND status = 'importing' AND complaint_id IS NULL`,
    [ids, error],
  );
  // Failed after the complaint was made: keep it (and never make it again),
  // and say on it what went wrong so someone checks it.
  const made = (await query(
    `UPDATE complaint_import_candidates SET status = 'imported', error = $2
      WHERE id = ANY($1::uuid[]) AND status = 'importing' AND complaint_id IS NOT NULL RETURNING complaint_id`,
    [ids, error],
  )).rows;
  for (const id of new Set(made.map((r) => r.complaint_id))) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [id, londonDateOf(new Date()), `Please check: bringing this complaint in from past emails stopped part-way (${error || 'error'}), so some of its emails may be missing.`, AUTO_SEARCH],
    );
    await query('UPDATE complaints SET needs_check = true, checked_at = NULL, checked_by = NULL WHERE id = $1', [id]);
  }
}

// A restart part-way through an import leaves its rows 'importing' with
// nobody working on them. On start-up they go back to the list, with a note.
// If the complaint had already been created, it is kept (never created twice)
// and its timeline says the import was cut short, so someone checks it.
export async function releaseStuckImports({ deploy = false } = {}) {
  const made = (await query(
    `UPDATE complaint_import_candidates SET status = 'imported',
            error = 'Interrupted by a restart after the complaint was created; some emails may not have been brought in.'
      WHERE status = 'importing' AND complaint_id IS NOT NULL RETURNING complaint_id`,
  )).rows;
  for (const id of new Set(made.map((r) => r.complaint_id))) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [id, londonDateOf(new Date()), 'Please check: bringing this complaint in from past emails was cut short by a server restart, so some of its emails may be missing.', AUTO_SEARCH],
    );
    await query('UPDATE complaints SET needs_check = true, checked_at = NULL, checked_by = NULL WHERE id = $1', [id]);
  }
  // Nothing was created: back on the list. A deploy's restart isn't a
  // failure of this complaint, so it doesn't count as a try. Anything else
  // (the server stopping unexpectedly, perhaps because of this very import)
  // does count, so an import that brings the server down can't be retried on
  // every restart for ever: it gets the usual three tries, half an hour apart.
  const { rowCount } = deploy
    ? await query(
      `UPDATE complaint_import_candidates
          SET status = 'pending', error = NULL, import_attempts = GREATEST(import_attempts - 1, 0)
        WHERE status = 'importing' AND complaint_id IS NULL`,
    )
    : await query(
      `UPDATE complaint_import_candidates
          SET status = 'pending', error = 'Interrupted: the server stopped unexpectedly during this import.'
        WHERE status = 'importing' AND complaint_id IS NULL`,
    );
  return rowCount + made.length;
}

// Runs an import or link in the background (they can take minutes: every
// email is fetched and read), after the claim has been made so the caller can
// be told at once whether it was taken. A failure hands the rows back to the
// list with the reason shown against them.
// Imports and links wait their turn, two at a time: "Import all" claims
// twenty at once, and each one fetches every email and has the AI read them.
const IMPORT_SLOTS = 2;
let slotsInUse = 0;
const waiting = [];
function inTurn(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      slotsInUse += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        slotsInUse -= 1;
        waiting.shift()?.();
      });
    };
    if (slotsInUse < IMPORT_SLOTS) go(); else waiting.push(go);
  });
}

export async function importInBackground(id, by) {
  id = String(id).toLowerCase();
  const group = await claimGroup(id, by);
  inTurn(() => importClaimed(id, group, by)).catch(async (err) => {
    console.error(`[complaints] import ${id} failed:`, err.message);
    await releaseGroup(group.map((c) => c.id), `Import failed: ${err.message}`).catch(() => {});
  });
  return { claimed: group.length };
}

export async function linkInBackground(id, complaintId, by) {
  id = String(id).toLowerCase();
  const c = (await query('SELECT id FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) throw Object.assign(new Error('Complaint not found'), { status: 404 });
  const group = await claimGroup(id, by);
  inTurn(() => linkClaimed(group, complaintId, by)).catch(async (err) => {
    console.error(`[complaints] link ${id} failed:`, err.message);
    await releaseGroup(group.map((g) => g.id), `Linking failed: ${err.message}`).catch(() => {});
  });
  return { claimed: group.length };
}

export async function importCandidate(id, by) {
  id = String(id).toLowerCase();
  const group = await claimGroup(id, by);
  try {
    return await importClaimed(id, group, by);
  } catch (err) {
    await releaseGroup(group.map((c) => c.id), `Import failed: ${err.message}`).catch(() => {});
    throw err;
  }
}

async function importClaimed(id, group, by) {
  const cand = group.find((c) => c.id === id);
  // Cleaned again here: rows found before the quick reading was cleaned as
  // it was stored still hold what the model said.
  const seed = cleanQuickReading(group.length > 1 ? mergeExtracted(group) : cand.extracted || {});
  const members = group.length ? group : [cand];
  const ourDomain = config.complaintEmail.domain.toLowerCase();

  // 1. Every email in the threads found for it.
  const msgs = [];
  const convs = new Set();
  for (const c of group.length ? group : [cand]) {
    convs.add(c.conversation_id);
    msgs.push(...(await fetchConversation(c.mailbox, c.conversation_id)).map((m) => ({ ...m, mailbox: c.mailbox })));
  }
  // 2. Other threads about it.
  const orgDomains = new Set(msgs.map((m) => domainOf(m.senderEmail)).filter((d) => d && d !== ourDomain));
  const mailboxes = [...new Set((group.length ? group : [cand]).map((c) => c.mailbox))];
  const extra = await gatherRelated(seed, mailboxes, convs, orgDomains);
  msgs.push(...extra);

  // 3. Read the whole story together. If that fails, the per-thread reading
  //    still makes a usable record.
  let x = null;
  if (msgs.length) {
    try {
      x = await reconstructComplaint(msgs);
    } catch (err) {
      console.error('[complaints] full read failed, using the thread summaries:', err.message);
    }
  }
  // Read in full, no formal complaint was ever made (a query, a disputed bill
  // that never became a complaint): nothing is created. It is put with the
  // threads ruled out, with the reason, and never read again.
  if (x && !x.is_complaint) {
    await query(
      `UPDATE complaint_import_candidates
          SET status = 'not_complaint', error = NULL, decided_by = $2,
              extracted = COALESCE(extracted, '{}'::jsonb) || $3::jsonb
        WHERE id = ANY($1::uuid[])`,
      [(group.length ? group : [cand]).map((c) => c.id), by,
        JSON.stringify({ is_complaint: false, why: `read in full: ${x.not_complaint_why || 'no formal complaint was made'}` })],
    );
    return null;
  }
  const pick = (k) => (x && x[k] != null && x[k] !== '' ? x[k] : seed[k] ?? null);
  // Dates come from the full reading alone when there is one: it drops a
  // date that is unreal, in the future or before the complaint was made, and
  // the quick reading must not put it back. Without it, the (cleaned) quick
  // reading's.
  const dateOf = (k) => ((x ? x[k] : seed[k]) || null);
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  // The group's first and last emails, whichever thread was clicked.
  const firstAt = new Date(Math.min(...members.map((c) => new Date(c.first_at).getTime())));
  const lastAt = new Date(Math.max(...members.map((c) => new Date(c.last_at).getTime())));
  const firstDay = londonDateOf(firstAt);

  // 4. The organisation: matched, or set up (with its complaints address, if
  //    the emails show it).
  const orgName = pick('org_name');
  // By name, or failing that by their complaints address as read from the
  // emails (its domain against the complaints addresses on file), so a name
  // read slightly differently doesn't set up a second organisation. Not every
  // domain in the thread: a debt collector writes about a supplier's bill.
  let org = orgName || x?.org_complaints_email
    ? await findOrgByName(orgName, {
      domains: [domainOf(x?.org_complaints_email)].filter(Boolean),
      ourDomain: config.complaintEmail.domain,
    })
    : null;
  if (!org && orgName) {
    org = (await query(
      `INSERT INTO organisations (name, type, complaints_email, research_status, notes)
       VALUES ($1, $2, $3, 'none', 'Set up when a past complaint was imported. Add its complaints procedure.')
       RETURNING *`,
      [orgName, pick('org_type') || 'other', x?.org_complaints_email || null],
    )).rows[0];
  } else if (org && !org.complaints_email && x?.org_complaints_email) {
    await query('UPDATE organisations SET complaints_email = $2 WHERE id = $1', [org.id, x.org_complaints_email]);
  }

  // The day the formal complaint was made (the full read quotes the sentence
  // that made it). If no email shows it, the first email's date stands in,
  // and the complaint says so: its deadlines and ombudsman dates rest on it.
  const raisedOn = iso(dateOf('raised_on')) || firstDay;
  const raisedGuessed = !iso(dateOf('raised_on'));
  // Never a step before the complaint was made (the first email's date can
  // stand in for a raised date the reading didn't give).
  const after = (v) => (iso(v) && iso(v) >= raisedOn ? iso(v) : null);

  // 5. The complaint, as complete as the emails allow.
  const stage = ['stage_1', 'stage_2', 'ombudsman'].includes(pick('stage')) ? pick('stage') : 'stage_1';
  const description = [pick('description') || seed.summary, x?.outcome ? `Outcome: ${x.outcome}` : null]
    .filter(Boolean).join('\n\n') || null;
  const threads = convs.size + new Set(extra.map((m) => m.conversationId)).size;
  const complaint = await createComplaint(
    {
      organisation_id: org?.id || null,
      org_name: org?.name || orgName || 'Unknown organisation',
      org_type: org?.type || pick('org_type') || 'other',
      subject: pick('subject') || cand.subject || 'Complaint',
      property: pick('property'),
      category: pick('category'),
      description,
      reference: pick('reference'),
      // Every account number read, from the whole story and each thread.
      account_numbers: [...new Set([...(x?.account_numbers || []), ...(seed.account_numbers || [])])],
      channel: pick('channel') || 'email',
      raised_on: raisedOn,
      stage,
      stage_started_on: stage === 'stage_1' ? null : after(x?.stage_started_on),
      acknowledged_on: after(dateOf('acknowledged_on')),
      responded_on: after(dateOf('responded_on')),
      final_response_on: after(x?.final_response_on),
      imported: true,
    },
    {
      by,
      needsCheck: true,
      // Recorded in the same transaction, so an import cut short from here
      // on (a restart, a failed statement) is known to have made this
      // complaint and is never made again.
      afterInsert: (client, row) => client.query(
        'UPDATE complaint_import_candidates SET complaint_id = $2 WHERE id = ANY($1::uuid[])',
        [members.map((c) => c.id), row.id],
      ),
      raisedNote: `Imported from past emails: ${plural(new Set(msgs.map((m) => m.messageId || m.graphId)).size, 'email')} ` +
        `across ${plural(threads, 'thread')}${extra.length ? `, ${new Set(extra.map((m) => m.conversationId)).size} of them found by reference or postcode` : ''}.`,
    },
  );

  // Its account numbers were read with the whole story.
  await query('UPDATE complaints SET accounts_read_at = now() WHERE id = $1', [complaint.id]);


  // 6. The timeline, rebuilt from the emails (the "raised" entry is already there).
  for (const e of x?.events || []) {
    if (e.type === 'raised') continue;
    if (e.date < raisedOn) continue; // before the complaint: background, not a step of it
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [complaint.id, e.date, e.type, e.note, 'Import (read from the emails)'],
    );
  }
  if (x?.complaint_evidence?.quote) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [complaint.id, raisedOn, `The complaint was made in the email of ${ukDate(raisedOn)}: "${x.complaint_evidence.quote}"`, 'Import (read from the emails)'],
    );
  }
  if (raisedGuessed || !x?.complaint_evidence?.quote) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [complaint.id, londonDateOf(new Date()),
        `Please check the date this complaint was made: ${raisedGuessed ? `no email clearly shows it, so the first email's date (${ukDate(raisedOn)}) was used` : `the full reading of the emails wasn't available, so ${ukDate(raisedOn)} is from a quicker reading`}. Its deadlines and when it can go to the ombudsman are worked out from this date; correct it with Edit details if it's wrong.`,
        'Import (read from the emails)'],
    );
  }
  if (x?.uncertain?.length) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [complaint.id, londonDateOf(new Date()), `Please check (the emails didn't make these clear): ${x.uncertain.join('; ')}.`, 'Import (read from the emails)'],
    );
  }

  // 7. Every email and attachment, filed on it.
  for (const m of msgs) {
    const eid = await storeEmail(m, { complaintId: complaint.id, method: 'import', mailbox: m.mailbox || cand.mailbox });
    if (eid) await processHistoricalEmail(eid);
  }

  // 8. Finished, if it was.
  if (pick('state') === 'resolved') {
    const on = after(dateOf('resolved_on')) || londonDateOf(lastAt);
    await query(`UPDATE complaints SET state = 'resolved', stage = 'resolved', closed_on = $2, outcome = $3 WHERE id = $1`,
      [complaint.id, on, x?.outcome || null]);
    if (!(x?.events || []).some((e) => e.type === 'resolved')) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'resolved',$3,$4)`,
        [complaint.id, on, x?.outcome ? `Resolved: ${x.outcome}` : 'Resolved (read from the past emails)', 'Import (read from the emails)'],
      );
    }
  }
  await recomputeDeadlines(complaint.id);
  await query(
    `UPDATE complaint_import_candidates SET status = 'imported', complaint_id = $2, decided_by = $3, error = NULL
      WHERE id = ANY($1::uuid[])`,
    [(group.length ? group : [cand]).map((c) => c.id), complaint.id, by],
  );
  scheduleReview(complaint.id);
  return complaint;
}

// A found thread that is a complaint already in the system: bring its emails
// onto that complaint. Each is read as a normal email would be, so an
// acknowledgement or response in the thread is recorded (with Undo), and
// future replies in the thread are filed there automatically.
export async function linkCandidate(id, complaintId, by, { historical = false } = {}) {
  id = String(id).toLowerCase();
  const c = (await query('SELECT id FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) throw Object.assign(new Error('Complaint not found'), { status: 404 });
  const group = await claimGroup(id, by);
  try {
    await linkClaimed(group, complaintId, by, { historical });
  } catch (err) {
    await releaseGroup(group.map((g) => g.id), `Linking failed: ${err.message}`).catch(() => {});
    throw err;
  }
}

// Linking one thread of an issue links the others found with it.
async function linkClaimed(group, complaintId, by, { historical = false } = {}) {
  for (const cand of group) {
    const msgs = await fetchConversation(cand.mailbox, cand.conversation_id);
    let added = 0;
    for (const m of msgs) {
      const eid = await storeEmail(m, { complaintId, method: 'linked', mailbox: cand.mailbox });
      if (!eid) continue;
      added += 1;
      try {
        // Threads brought in with an import are history (the dates came from
        // reading them together); linking to a live complaint reads each one.
        if (historical) await processHistoricalEmail(eid);
        else await processEmail(eid);
      } catch (err) {
        console.error(`[complaints] linked email ${eid} not processed:`, err.message);
      }
    }
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1, $2, 'note', $3, $4)`,
      [complaintId, londonDateOf(new Date()), `Email thread "${cand.subject || ''}" brought in from ${cand.mailbox} (${added} new email${added === 1 ? '' : 's'}).`, by],
    );
    await query(
      `UPDATE complaint_import_candidates SET status = 'imported', complaint_id = $2, decided_by = $3, error = NULL WHERE id = $1`,
      [cand.id, complaintId, by],
    );
  }
  scheduleReview(complaintId);
}

// A deploy restarts the server, which stops a search part-way. On start-up a
// search left "running" is picked up again with the same mailboxes and period;
// threads already read are skipped, so nothing is read (or paid for) twice.
export async function resumeInterruptedScan() {
  const s = await getSetting('past_scan');
  if (s?.status !== 'running' || running) return false;
  if (!config.ms.enabled || !config.anthropic.enabled) {
    await progress({ status: 'failed', error: 'Stopped by a restart, and the mailbox or AI is no longer set up.' });
    return false;
  }
  running = true;
  await progress({ stage: 'Carrying on after a restart' });
  runScan({ mailboxes: (s.mailboxes || []).filter(mailboxAllowed), months: s.months || 12, carry: { read: s.read || 0, found: s.found || 0 } })
    .catch(async (err) => progress({ status: 'failed', error: err.message }))
    .finally(() => { running = false; });
  return true;
}

// Skip a found complaint: every thread grouped with it, so automatic import
// doesn't bring back from its second thread what a person just skipped.
export async function skipCandidate(id, by) {
  id = String(id).toLowerCase();
  const group = await groupOf(id);
  const ids = [...new Set([id, ...group.map((c) => c.id)])];
  const { rows } = await query(
    `UPDATE complaint_import_candidates SET status = 'skipped', decided_by = $2
      WHERE id = ANY($1::uuid[]) AND status = 'pending' RETURNING id`,
    [ids, by],
  );
  if (!rows.some((r) => r.id === id)) throw Object.assign(new Error('This one has already been dealt with.'), { status: 409 });
  return rows.length;
}

// Switch automatic import on or off. Switching it on also deals with the ones
// already waiting (see runAutoImport).
export async function setAutoImport(on, by) {
  await setSetting('past_auto_import', Boolean(on), by);
  if (!on) return { imported: 0, linked: 0 };
  return runAutoImport(by || AUTO_SEARCH);
}

// Paused while a deploy waits to restart (see scripts/wait-for-imports.mjs),
// so a new import isn't started only to be cut off.
export async function importsPaused() {
  const p = await getSetting('imports_paused');
  return Boolean(p?.until && new Date(p.until) > new Date());
}

const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

// What automatic import will do with one found complaint (a group of threads),
// and whether it is due now. The single rule: runAutoImport acts on it, and
// the list shows its note, so what the page promises is what happens.
//   - not set up (no mailbox or AI): nothing
//   - failed AUTO_TRIES times: left for a person
//   - certainly already on file (same organisation, postcode and flat/house
//     number): its emails are linked there
//   - possibly already on file: left for a person to Link or Import
//   - the AI was sure of at least one thread: imported
//   - otherwise: left for a person
// A failure waits half an hour before the next try; a pause (a deploy about
// to restart) or a related import still running holds it for a few minutes.
export function autoPlan(group, { hit = null, certain = false, relatedRunning = false, paused = false, enabled = true, skipped = false, now = new Date() } = {}) {
  const person = (note) => ({ will: null, due: false, note });
  if (!enabled) return person('Automatic import needs the mailbox connection and the AI set up on the server.');
  // The account number is what it is matched on, so it is read first.
  if (group.some((c) => !c.accounts_read_at && !Array.isArray(c.extracted?.account_numbers))) {
    return { will: null, due: false, note: 'Reading its account number first; then it is matched and imported or linked.' };
  }
  const failed = group.filter((c) => c.error);
  const tries = Math.max(0, ...group.map((c) => c.import_attempts || 0));
  if (failed.length && tries >= AUTO_TRIES) return person(`Tried ${tries} times without success: press Import to try again, or Skip.`);
  let plan;
  if (hit && certain) plan = { will: 'link', note: `Its emails will be added to ${hit.ref_code || 'the complaint already on file'} automatically.` };
  else if (skipped) return person('You skipped another thread about the same complaint, so this one waits for you: Import it if it should be tracked after all, or Skip.');
  else if (hit) return person('May already be in the system: check it and Link, or Import if it’s a different complaint.');
  else if (group.some((c) => c.extracted?.confidence === 'high')) plan = { will: 'import', note: 'Will be imported automatically in the next few minutes.' };
  else return person('Waiting for you: the AI was less sure this is a complaint to track.');
  if (failed.length) {
    const last = Math.max(0, ...failed.map((c) => (c.last_attempt_at ? new Date(c.last_attempt_at).getTime() : 0)));
    const next = new Date(last + 30 * 60000);
    if (next > now) return { ...plan, due: false, note: `That didn’t work last time; it will be tried again automatically after ${hhmm(next)}.` };
    plan = { ...plan, note: 'That didn’t work last time; it will be tried again automatically in the next few minutes.' };
  }
  if (paused) return { ...plan, due: false, note: `${plan.note} (Paused for a few minutes while an update is installed.)` };
  if (relatedRunning) return { ...plan, due: false, note: 'Waiting for a related import to finish first.' };
  return { ...plan, due: true };
}

// With automatic import on, act on every found complaint autoPlan says is due.
// Runs at start-up (so a deploy part-way through carries on) and after each
// 5-minute email check; with nothing waiting it is one query.
let autoRunning = false;
export const AUTO_TRIES = 3;
export async function runAutoImport(by = AUTO_SEARCH) {
  if (autoRunning || !(await getSetting('past_auto_import'))) return { imported: 0, linked: 0 };
  if (await importsPaused()) return { imported: 0, linked: 0 };
  if (!config.ms.enabled || !config.anthropic.enabled) return { imported: 0, linked: 0 };
  autoRunning = true;
  let imported = 0;
  let linked = 0;
  try {
    const pending = (await query(`SELECT * FROM complaint_import_candidates WHERE status = 'pending' ORDER BY first_at`)).rows;
    for (const first of groupCandidates(pending)) {
      // eslint-disable-next-line no-await-in-loop
      await serially(async () => {
        if (!(await getSetting('past_auto_import'))) return; // switched off part-way
        const group = await groupOf(first[0].id); // as it is now, not as it was
        if (!group.length) return; // taken in meanwhile
        const { hit, certain } = await onFileFor(group);
        const plan = autoPlan(group, {
          hit, certain,
          relatedRunning: await relatedImportRunning(group),
          paused: await importsPaused(),
          skipped: await relatedSkipped(group),
        });
        if (!plan.due) return;
        if (plan.will === 'link') {
          await linkCandidate(group[0].id, hit.id, AUTO_SEARCH);
          linked += 1;
        } else if (plan.will === 'import') {
          if (await importCandidate(group[0].id, by)) imported += 1;
        }
      }).catch((err) => {
        if (err.status !== 409) console.error(`[complaints] auto-import ${first[0].id} failed:`, err.message);
      });
    }
  } finally {
    autoRunning = false;
  }
  return { imported, linked };
}
