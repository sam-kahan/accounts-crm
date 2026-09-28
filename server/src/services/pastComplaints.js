import { query } from '../db/pool.js';
import { config } from '../config.js';
import { londonDateOf } from '../lib/dates.js';
import { searchMailbox, fetchConversation } from './graphMail.js';
import { parseImportedComplaint, triageComplaintThread } from './complaintAssistant.js';
import { reconstructComplaint, belongsToComplaint } from './complaintReconstruct.js';
import { domainOf } from './mailWatch.js';
import { storeEmail } from './emailIngest.js';
import { getSetting, setSetting } from './settings.js';
import { createComplaint } from './complaintCreate.js';
import { findOrgByName, groupCandidates, mergeExtracted, findExistingComplaint, postcodeOf } from './orgMatch.js';
import { processHistoricalEmail, processEmail } from './complaintEmailProcessor.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { scheduleReview } from './complaintReview.js';

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

async function runScan({ mailboxes, months, carry = null }) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
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
        const dup = await query(
          `SELECT 1 FROM complaint_import_candidates WHERE message_ids && $1::text[]
           UNION ALL SELECT 1 FROM complaint_emails WHERE message_id = ANY($1::text[]) LIMIT 1`,
          [ids],
        );
        if (dup.rows.length) return;
      }
      let extracted;
      const text = threadText(msgs);
      if (!couldBeOurComplaint(msgs, config.complaintEmail.domain.toLowerCase())) {
        extracted = { is_complaint: false, why: 'no email from Greenco to an outside party' };
      } else if (!(await triageComplaintThread(text).catch(() => true))) {
        extracted = { is_complaint: false, why: 'quick look: not a complaint Greenco made' };
      } else {
        try {
          extracted = await parseImportedComplaint({
            text,
            hint: 'This is an email thread found in a Greenco mailbox. Decide first whether it is a complaint Greenco made.',
          });
        } catch {
          extracted = { is_complaint: false, why: 'could not be read' };
        }
      }
      const isComplaint = extracted.is_complaint !== false && Boolean(extracted.subject);
      if (isComplaint) found += 1;
      await query(
        `INSERT INTO complaint_import_candidates
           (mailbox, conversation_id, graph_ids, subject, first_at, last_at, message_count, extracted, status, message_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (mailbox, conversation_id) DO NOTHING`,
        [
          t.mailbox, t.conversationId, msgs.map((m) => m.graphId), msgs[0].subject,
          msgs[0].receivedAt, msgs[msgs.length - 1].receivedAt, msgs.length,
          JSON.stringify(extracted), isComplaint ? 'pending' : 'not_complaint',
          msgs.map((m) => m.messageId).filter(Boolean),
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
          const pc = postcodeOf(extracted.property);
          const complaints = (await query('SELECT id, org_name, organisation_id, property, raised_on FROM complaints')).rows;
          const orgs = (await query('SELECT id, name FROM organisations')).rows;
          const hit = findExistingComplaint(complaints, orgs, extracted);
          if (hit && pc && postcodeOf(hit.property) === pc) {
            await linkCandidate(cand.id, hit.id, AUTO_SEARCH);
            found -= 1; // not a new one to look at
          } else if (!hit && extracted.confidence === 'high' && (await getSetting('past_auto_import'))) {
            // Switched on: a complaint it is sure of is imported as it is found
            // (marked "to check", like everything the system creates itself).
            await importCandidate(cand.id, AUTO_SEARCH);
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
// Claim a found complaint (and the threads grouped with it) for one import or
// link, so a second click, a second person, or automatic import can't bring it
// in twice. The claim is a single UPDATE ... WHERE status = 'pending': exactly
// one caller gets the rows. Returns the claimed group, or throws 409.
async function claimGroup(id, by) {
  const group = await groupOf(id);
  const ids = (group.length ? group : [{ id }]).map((c) => c.id);
  const { rows } = await query(
    `UPDATE complaint_import_candidates SET status = 'importing', error = NULL, decided_by = $2
      WHERE id = ANY($1::uuid[]) AND status = 'pending' RETURNING *`,
    [ids, by],
  );
  if (!rows.some((r) => r.id === id)) {
    // Someone else has it; hand back anything of the group this call did take.
    if (rows.length) await releaseGroup(rows.map((r) => r.id));
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
export async function releaseStuckImports() {
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
  const { rowCount } = await query(
    `UPDATE complaint_import_candidates SET status = 'pending',
            error = 'The import was interrupted by a restart before anything was created. Please press Import again.'
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
  const group = await claimGroup(id, by);
  inTurn(() => importClaimed(id, group, by)).catch(async (err) => {
    console.error(`[complaints] import ${id} failed:`, err.message);
    await releaseGroup(group.map((c) => c.id), `Import failed: ${err.message}`).catch(() => {});
  });
  return { claimed: group.length };
}

export async function linkInBackground(id, complaintId, by) {
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
  const seed = group.length > 1 ? mergeExtracted(group) : cand.extracted || {};
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
  const pick = (k) => (x && x[k] != null && x[k] !== '' ? x[k] : seed[k] ?? null);
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const firstDay = londonDateOf(new Date(cand.first_at));

  // 4. The organisation: matched, or set up (with its complaints address, if
  //    the emails show it).
  const orgName = pick('org_name');
  let org = orgName ? await findOrgByName(orgName) : null;
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
      channel: pick('channel') || 'email',
      raised_on: iso(pick('raised_on')) || firstDay,
      stage,
      stage_started_on: stage === 'stage_1' ? null : iso(x?.stage_started_on),
      acknowledged_on: iso(pick('acknowledged_on')),
      responded_on: iso(pick('responded_on')),
      final_response_on: iso(x?.final_response_on),
      imported: true,
    },
    {
      by,
      needsCheck: true,
      raisedNote: `Imported from past emails: ${new Set(msgs.map((m) => m.messageId || m.graphId)).size} email(s) ` +
        `across ${threads} thread(s)${extra.length ? `, ${new Set(extra.map((m) => m.conversationId)).size} of them found by reference or postcode` : ''}.`,
    },
  );

  // Recorded straight away, so an import cut short from here on is known to
  // have made this complaint and is never made again.
  await query('UPDATE complaint_import_candidates SET complaint_id = $2 WHERE id = ANY($1::uuid[])',
    [group.map((c) => c.id), complaint.id]);

  // 6. The timeline, rebuilt from the emails (the "raised" entry is already there).
  for (const e of x?.events || []) {
    if (e.type === 'raised') continue;
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [complaint.id, e.date, e.type, e.note, 'Import (read from the emails)'],
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
    const on = iso(pick('resolved_on')) || londonDateOf(new Date(cand.last_at));
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
  runScan({ mailboxes: s.mailboxes || [], months: s.months || 24, carry: { read: s.read || 0, found: s.found || 0 } })
    .catch(async (err) => progress({ status: 'failed', error: err.message }))
    .finally(() => { running = false; });
  return true;
}

// Switch automatic import on or off. Switching it on also imports the ones
// already waiting that the AI was sure of and that aren't on file already.
export async function setAutoImport(on, by) {
  await setSetting('past_auto_import', Boolean(on), by);
  if (!on) return { imported: 0 };
  const pending = (await query(`SELECT * FROM complaint_import_candidates WHERE status = 'pending' ORDER BY first_at`)).rows;
  let imported = 0;
  for (const c of pending) {
    if (c.extracted?.confidence !== 'high') continue;
    // eslint-disable-next-line no-await-in-loop
    await serially(async () => {
      const still = (await query(`SELECT status FROM complaint_import_candidates WHERE id = $1`, [c.id])).rows[0];
      if (still?.status !== 'pending') return; // taken in with an earlier one of the same issue
      const complaints = (await query('SELECT id, org_name, organisation_id, property, raised_on FROM complaints')).rows;
      const orgs = (await query('SELECT id, name FROM organisations')).rows;
      if (findExistingComplaint(complaints, orgs, c.extracted)) return; // left for a person to link
      await importCandidate(c.id, by || AUTO_SEARCH);
      imported += 1;
    }).catch((err) => {
      if (err.status !== 409) console.error(`[complaints] auto-import ${c.id} failed:`, err.message);
    });
  }
  return { imported };
}
