import { query } from '../db/pool.js';
import { config } from '../config.js';
import { londonDateOf } from '../lib/dates.js';
import { searchMailbox, fetchConversation } from './graphMail.js';
import { parseImportedComplaint, triageComplaintThread } from './complaintAssistant.js';
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

  // 2. Read each thread.
  let read = before;
  let found = carry?.found || 0;
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
    read += 1;
    if (read % 5 === 0 || read === before + list.length) await progress({ read, found, errors: errors.slice(-10) });
  }
  await progress({ status: 'done', stage: 'Finished', read, found, finished_at: new Date().toISOString(), errors: errors.slice(-10) });
}

// Import one found complaint: create it at its stage with its dates, then
// bring in the whole thread (read in full, attachments kept).
// The pending threads about the same issue as this one (itself included).
async function groupOf(id) {
  const pending = (await query(`SELECT * FROM complaint_import_candidates WHERE status = 'pending'`)).rows;
  return groupCandidates(pending).find((g) => g.some((c) => c.id === id)) || [];
}

export async function importCandidate(id, by) {
  const cand = (await query('SELECT * FROM complaint_import_candidates WHERE id = $1', [id])).rows[0];
  if (!cand) throw Object.assign(new Error('Not found'), { status: 404 });
  if (cand.status !== 'pending') throw Object.assign(new Error('This one has already been dealt with.'), { status: 409 });
  // Every thread about the same issue becomes this one complaint.
  const group = await groupOf(id);
  const others = group.filter((c) => c.id !== id);
  const x = group.length > 1 ? mergeExtracted(group) : cand.extracted || {};
  const msgs = await fetchConversation(cand.mailbox, cand.conversation_id);
  const firstDay = londonDateOf(new Date(cand.first_at));
  let org = x.org_name ? await findOrgByName(x.org_name) : null;
  if (!org && x.org_name) {
    // Set it up so the complaint is linked; its procedure is added (or
    // researched) on the Organisations page, and the complaint says so.
    org = (await query(
      `INSERT INTO organisations (name, type, research_status, notes)
       VALUES ($1, $2, 'none', 'Set up when a past complaint was imported. Add its complaints procedure.')
       RETURNING *`,
      [x.org_name, ['council', 'housing_association', 'water', 'energy', 'managing_agent', 'supplier', 'other'].includes(x.org_type) ? x.org_type : 'other'],
    )).rows[0];
  }
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
  for (const o of others) await linkCandidate(o.id, complaint.id, by, { historical: true, withGroup: false });
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
