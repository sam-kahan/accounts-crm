import { query } from '../db/pool.js';
import { config } from '../config.js';
import { londonDateOf } from '../lib/dates.js';
import { searchMailbox, fetchConversation } from './graphMail.js';
import { parseImportedComplaint, triageComplaintThread } from './complaintAssistant.js';
import { domainOf } from './mailWatch.js';
import { storeEmail } from './emailIngest.js';
import { getSetting, setSetting } from './settings.js';
import { createComplaint } from './complaintCreate.js';
import { findOrgByName } from './orgMatch.js';
import { processHistoricalEmail } from './complaintEmailProcessor.js';
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
const MAX_THREADS = 250;

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

async function runScan({ mailboxes, months }) {
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
        for (const m of await searchMailbox(mb, phrase)) {
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
  await progress({ stage: 'Reading each email thread', threads: list.length, errors });

  // 2. Read each thread.
  let read = 0;
  let found = 0;
  for (const t of list) {
    try {
      const msgs = await fetchConversation(t.mailbox, t.conversationId);
      if (!msgs.length) continue;
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
    } catch (err) {
      errors.push(`thread ${t.conversationId.slice(0, 12)}…: ${err.message}`);
    }
    read += 1;
    if (read % 5 === 0 || read === list.length) await progress({ read, found, errors: errors.slice(-10) });
  }
  await progress({ status: 'done', stage: 'Finished', read, found, finished_at: new Date().toISOString(), errors: errors.slice(-10) });
}

// Import one found complaint: create it at its stage with its dates, then
// bring in the whole thread (read in full, attachments kept).
export async function importCandidate(id, by) {
  const cand = (await query('SELECT * FROM complaint_import_candidates WHERE id = $1', [id])).rows[0];
  if (!cand) throw Object.assign(new Error('Not found'), { status: 404 });
  if (cand.status !== 'pending') throw Object.assign(new Error('This one has already been dealt with.'), { status: 409 });
  const x = cand.extracted || {};
  const msgs = await fetchConversation(cand.mailbox, cand.conversation_id);
  const firstDay = londonDateOf(new Date(cand.first_at));
  const org = x.org_name ? await findOrgByName(x.org_name) : null;
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

  const complaint = await createComplaint(
    {
      organisation_id: org?.id || null,
      org_name: org?.name || x.org_name || 'Unknown organisation',
      org_type: org?.type || x.org_type || 'other',
      subject: x.subject || cand.subject || 'Complaint',
      property: x.property || null,
      category: x.category || null,
      description: [x.summary, x.description].filter(Boolean).join('\n\n') || null,
      reference: x.reference || null,
      channel: x.channel || 'email',
      raised_on: iso(x.raised_on) || firstDay,
      stage: ['stage_1', 'stage_2', 'ombudsman'].includes(x.stage) ? x.stage : 'stage_1',
      acknowledged_on: iso(x.acknowledged_on),
      responded_on: iso(x.responded_on),
      imported: true,
    },
    { by, raisedNote: `Imported from past emails (${cand.message_count} in the thread, from ${cand.mailbox})` },
  );

  for (const m of msgs) {
    const eid = await storeEmail(m, { complaintId: complaint.id, method: 'import', mailbox: cand.mailbox });
    if (eid) await processHistoricalEmail(eid);
  }
  if (x.state === 'resolved') {
    const on = iso(x.resolved_on) || londonDateOf(new Date(cand.last_at));
    await query(`UPDATE complaints SET state = 'resolved', stage = 'resolved', closed_on = $2 WHERE id = $1`, [complaint.id, on]);
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'resolved',$3,$4)`,
      [complaint.id, on, 'Resolved (read from the past emails)', by],
    );
  }
  await recomputeDeadlines(complaint.id);
  await query(
    `UPDATE complaint_import_candidates SET status = 'imported', complaint_id = $2, decided_by = $3 WHERE id = $1`,
    [id, complaint.id, by],
  );
  scheduleReview(complaint.id);
  return complaint;
}
