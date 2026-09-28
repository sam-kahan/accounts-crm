import { query, pool } from '../db/pool.js';
import { complaintEmailAddress, complaintInboxAddress } from '../config.js';
import { todayISO } from '../lib/dates.js';

// ---------------------------------------------------------------------------
// Email-to-complaint ingestion. The mailbox we poll is a shared, domain-wide
// CATCH-ALL (the same one refurb reads): every address that isn't a real
// mailbox lands there, spam included. So we only match on the two DELIBERATE,
// unique signals — the complaint's own catch-all address in the recipients, or
// its ref code in the text — and we store ONLY matched emails. Everything else
// (the firehose of unrelated mail) is ignored, never written to the DB. Looser
// heuristics (org email / property) are intentionally NOT used here: on a
// catch-all they would wrongly attach unrelated mail to a complaint.
// matchEmailToComplaint stays a pure function so it can be unit-tested.
// ---------------------------------------------------------------------------

export function matchEmailToComplaint(email, index, inboxAddress = null) {
  const hay = `${email.subject ?? ''} ${email.bodyPreview ?? ''}`.toLowerCase();
  const addrs = [email.senderEmail, ...(email.toAddresses || [])]
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  // 1. The complaint's own catch-all address in the recipients (most reliable —
  //    you CC/BCC complaint-<code>@domain, which lands in the catch-all mailbox).
  for (const c of index) {
    if (c.email_address && addrs.includes(c.email_address.toLowerCase())) {
      return { complaintId: c.id, method: 'address' };
    }
  }
  // 2. Complaint reference code in the subject/body (fallback if the address
  //    wasn't CC'd but the ref survived in the thread). Also unique to us.
  for (const c of index) {
    if (c.ref_code && hay.includes(c.ref_code.toLowerCase())) {
      return { complaintId: c.id, method: 'ref_code' };
    }
  }
  // 3. Sent to the general complaints inbox: deliberately ours, so it is kept,
  //    and the AI works out which complaint it belongs to.
  if (inboxAddress && addrs.includes(inboxAddress.toLowerCase())) {
    return { complaintId: null, method: 'inbox' };
  }
  return { complaintId: null, method: 'unmatched' };
}

async function buildIndex() {
  const { rows } = await query(`SELECT id, ref_code FROM complaints`);
  return rows.map((c) => ({ ...c, email_address: complaintEmailAddress(c.ref_code) }));
}

// Store the emails that belong to complaints (or came to the general inbox).
// Returns the ids of the newly stored ones; the caller hands those to
// processEmail(), which reads them in full, files them and records what they
// mean. The timeline entry is written there, once it is known what arrived.
export async function ingestEmails(emails) {
  const index = await buildIndex();
  const inbox = complaintInboxAddress();
  let matched = 0;
  const ids = [];

  for (const e of emails) {
    const m = matchEmailToComplaint(e, index, inbox);
    // Shared catch-all: only persist emails that are deliberately ours. The
    // rest of the mailbox (spam / other teams' mail) is left untouched.
    if (!m.complaintId && m.method !== 'inbox') continue;
    matched += 1;
    const ins = await query(
      `INSERT INTO complaint_emails
         (complaint_id, graph_id, message_id, subject, sender_name, sender_email,
          to_addresses, body_preview, received_at, match_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (graph_id) DO NOTHING
       RETURNING id`,
      [
        m.complaintId, e.graphId, e.messageId, e.subject, e.senderName,
        e.senderEmail, e.toAddresses || [], e.bodyPreview, e.receivedAt, m.method,
      ],
    );
    if (ins.rows.length) ids.push(ins.rows[0].id);
  }

  return { fetched: emails.length, inserted: ids.length, matched, ids };
}

export function listComplaintEmails(complaintId) {
  return query(
    `SELECT * FROM complaint_emails WHERE complaint_id = $1 ORDER BY received_at DESC`,
    [complaintId],
  ).then((r) => r.rows);
}

// Record an email the user sent from the app against a complaint, and add a
// timeline entry. Stored as direction 'outbound' / match_method 'sent'.
export async function recordOutboundEmail({ complaintId, fromEmail, to, cc, subject, body, sentBy }) {
  const recipients = [...(to || []), ...(cc || [])].filter(Boolean);
  const graphId = `out-${globalThis.crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO complaint_emails
         (complaint_id, graph_id, message_id, subject, sender_name, sender_email,
          to_addresses, body_preview, received_at, direction, match_method,
          reviewed_at, reviewed_as, reviewed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'outbound','sent',now(),'sent',$9)`,
      [
        complaintId, graphId, graphId, subject, 'You (sent from CRM)', fromEmail,
        recipients, (body || '').slice(0, 2000), sentBy || null,
      ],
    );
    await client.query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1, $2, 'chased', $3, $4)`,
      [
        complaintId, todayISO(),
        `Email sent: ${subject || '(no subject)'}, to ${recipients.join(', ')}`,
        sentBy || null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
