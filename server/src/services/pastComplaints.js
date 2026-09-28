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
    stage: 'Searching the mailboxes', threads: 0, read: 0, found: 0, errors: [],
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
  const seen = new Set(
    (await query('SELECT mailbox, conversation_id FROM complaint_import_candidates')).rows
      .map((r) => `${r.mailbox}|${r.conversation_id}`),
  );
  const threads = new Map(); // key mailbox|conversation -> { mailbox, conversationId }
  for (const mb of mailboxes) {
    for (const phrase of PHRASES) {
      try {
        for (const m of await searchMailbox(mb, phrase, 2500)) {
          if (!m.conversationId || m.receivedAt < cutoff || known.has(m.conversationId)) continue;
          const key = `${mb}|${m.conversationId}`;
          if (!seen.has(key)) threads.set(key, { mailbox: mb, conversationId: m.conversationId });
        }
      } catch (err) {
        errors.push(`${mb} "${phrase}": ${err.message}`);
        if (err.status === 403 || err.status === 404) break; // no access to this mailbox
      }
      if (threads.size >= MAX_THREADS) break;
    }
  }
  const list = [...threads.values()].slice(0, MAX_THREADS);
  // Carrying on after a restart: the counts continue from where they were.
  const before = carry?.read || 0;
  await progress({ stage: 'Reading each email thread', threads: before + list.length, errors });

  // 2. Read the threads, four at a time: each can mean waiting on the AI, and
  // reading them side by side is several times quicker for the same cost.
  let read = before;
  let found = carry?.found || 0;
  const readOne = async (t) => {
    try {
      const msgs = await fetchConversation(t.mailbox, t.conversationId);
      if (!msgs.length) return;
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
           (mailbox, conversation_id, graph_ids, subject, first_at, last_at, message_count, extracted, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (mailbox, conversation_id) DO NOTHING`,
        [
          t.mailbox, t.conversationId, msgs.map((m) => m.graphId), msgs[0].subject,
          msgs[0].receivedAt, msgs[msgs.length - 1].receivedAt, msgs.length,
          JSON.stringify(extracted), isComplaint ? 'pending' : 'not_complaint',
        ],
      );
      // Certain to be a complaint already in the system (same organisation,
      // same property postcode): its emails are added there straight away,
      // rather than waiting for someone to press Link.
      if (isComplaint) {
        const cand = (await query(
          `SELECT id FROM complaint_import_candidates WHERE mailbox = $1 AND conversation_id = $2 AND status = 'pending'`,
          [t.mailbox, t.conversationId],
        )).rows[0];
        const pc = postcodeOf(extracted.property);
        const complaints = (await query('SELECT id, org_name, organisation_id, property, raised_on FROM complaints')).rows;
        const orgs = (await query('SELECT id, name FROM organisations')).rows;
        const hit = findExistingComplaint(complaints, orgs, extracted);
        if (cand && hit && pc && postcodeOf(hit.property) === pc) {
          await linkCandidate(cand.id, hit.id, 'Automatic (past-complaints search)', { withGroup: false });
          found -= 1; // not a new one to look at
        }
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
        for (const m of await searchMailbox(mb, phrase, 200)) {
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
export async function importCandidate(id, by) {
  const cand = (await query('SELECT * FROM complaint_import_candidates WHERE id = $1', [id])).rows[0];
  if (!cand) throw Object.assign(new Error('Not found'), { status: 404 });
  if (cand.status !== 'pending') throw Object.assign(new Error('This one has already been dealt with.'), { status: 409 });
  const group = await groupOf(id);
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
      raisedNote: `Imported from past emails: ${new Set(msgs.map((m) => m.messageId || m.graphId)).size} email(s) ` +
        `across ${threads} thread(s)${extra.length ? `, ${new Set(extra.map((m) => m.conversationId)).size} of them found by reference or postcode` : ''}.`,
    },
  );

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
    `UPDATE complaint_import_candidates SET status = 'imported', complaint_id = $2, decided_by = $3
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
export async function linkCandidate(id, complaintId, by, { historical = false, withGroup = true } = {}) {
  const cand = (await query('SELECT * FROM complaint_import_candidates WHERE id = $1', [id])).rows[0];
  if (!cand) throw Object.assign(new Error('Not found'), { status: 404 });
  if (cand.status !== 'pending') throw Object.assign(new Error('This one has already been dealt with.'), { status: 409 });
  const c = (await query('SELECT id FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) throw Object.assign(new Error('Complaint not found'), { status: 404 });
  // Linking one thread of an issue links the others found with it.
  const others = withGroup ? (await groupOf(id)).filter((o) => o.id !== id) : [];
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
    `UPDATE complaint_import_candidates SET status = 'imported', complaint_id = $2, decided_by = $3 WHERE id = $1`,
    [id, complaintId, by],
  );
  for (const o of others) await linkCandidate(o.id, complaintId, by, { historical, withGroup: false });
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
