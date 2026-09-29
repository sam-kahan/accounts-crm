import { query, pool } from '../db/pool.js';
import { complaintEmailAddress, complaintInboxAddress } from '../config.js';
import { todayISO, londonDateOf } from '../lib/dates.js';
import { passOverStuck, STUCK_TRIES } from './mailCheckpoint.js';

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
export async function ingestEmails(emails, { mailbox = null } = {}) {
  const index = await buildIndex();
  const inbox = complaintInboxAddress();
  let matched = 0;
  const ids = [];

  const errors = [];
  let stoppedAt = null;
  for (const e of emails) {
    // A bounce is flagged for a person to look into, never filed.
    try {
      const { bounceFromMailbox } = await import('./bounces.js');
      const { fetchMessageText } = await import('./graphMail.js');
      if (await bounceFromMailbox(e, mailbox, (m) => fetchMessageText(m.graphId, mailbox || undefined))) continue;
    } catch (err) {
      console.error('[complaints] bounce not recorded:', err.message);
    }
    const m = matchEmailToComplaint(e, index, inbox);
    // Shared catch-all: only persist emails that are deliberately ours. The
    // rest of the mailbox (spam / other teams' mail) is left untouched.
    if (!m.complaintId && m.method !== 'inbox') continue;
    matched += 1;
    try {
      const id = await storeEmail(e, { complaintId: m.complaintId, method: m.method, mailbox });
      if (id) ids.push(id);
    } catch (err) {
      // Stop here, so the checkpoint doesn't move past it, unless it has
      // failed three looks running (then it is passed over and said).
      if (!mailbox || !(await passOverStuck(mailbox, e))) {
        errors.push(`an email couldn't be stored (${err.message}); tried again next check`);
        stoppedAt = e.receivedAt;
        break;
      }
      errors.push(`an email ("${String(e.subject || '').slice(0, 80)}") couldn't be stored after ${STUCK_TRIES} checks and was passed over: ${err.message}`);
    }
  }

  return { fetched: emails.length, inserted: ids.length, matched, ids, errors, stoppedAt };
}

// Store one email, once: the same message copied to two mailboxes we read
// (the catch-all and accounts@, say) is the same email, so it is matched on its
// internet message id as well as Graph's per-mailbox id. Returns the new id,
// or null if it was already on file.
export async function storeEmail(e, { complaintId = null, method, mailbox = null }) {
  // Found by watching (not deliberately forwarded): an email that was ruled
  // out, or was on a complaint since deleted, is not brought back.
  if (e.messageId && ['watch', 'watch_new', 'account', 'thread'].includes(method)) {
    // Already read and found unrelated: not stored (or paid for) again.
    const gone = await query('SELECT 1 FROM complaint_email_discards WHERE message_id = $1', [e.messageId]);
    if (gone.rows.length) return null;
  }
  // Unique on graph_id and on message_id: a copy already on file (or being
  // stored by another reader at this moment) is simply not stored twice.
  const ins = await query(
    `INSERT INTO complaint_emails
       (complaint_id, graph_id, message_id, subject, sender_name, sender_email,
        to_addresses, body_preview, received_at, match_method, conversation_id, source_mailbox)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      complaintId, e.graphId, e.messageId, e.subject, e.senderName, e.senderEmail,
      e.toAddresses || [], e.bodyPreview, e.receivedAt, method, e.conversationId || null, mailbox,
    ],
  );
  return ins.rows[0]?.id || null;
}

export function listComplaintEmails(complaintId) {
  return query(
    `SELECT * FROM complaint_emails WHERE complaint_id = $1 ORDER BY received_at DESC`,
    [complaintId],
  ).then((r) => r.rows);
}

// Record an email the user sent from the app against a complaint, and add a
// timeline entry. Stored as direction 'outbound' / match_method 'sent'.
// `messageId` is the Message-ID the email went out with: the copies that come
// back (to the complaint's own address, to utilities@) carry the same one, so
// they are recognised as this email rather than stored as a new one.
// `partyId`: the further organisation it was sent to (migration 029), so
// "when did we last write to them" is answered per organisation.
// `sentAt` is when it went, when that isn't now (an email confirmed as gone
// after a restart cut its send short): the record and its "sent" entry are
// dated then, never the day someone confirmed it.
export async function recordOutboundEmail({ complaintId, fromEmail, to, cc, subject, body, sentBy, messageId = null, partyId = null, sentAt = null }) {
  const recipients = [...(to || []), ...(cc || [])].filter(Boolean);
  const graphId = `out-${globalThis.crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `INSERT INTO complaint_emails
         (complaint_id, graph_id, message_id, subject, sender_name, sender_email,
          to_addresses, body_preview, received_at, direction, match_method,
          reviewed_at, reviewed_as, reviewed_by, party_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($11::timestamptz, now()),'outbound','sent',now(),'sent',$9,$10)
       RETURNING id`,
      [
        complaintId, graphId, messageId || graphId, subject, 'You (sent from CRM)', fromEmail,
        recipients, (body || '').slice(0, 2000), sentBy || null, partyId, sentAt,
      ],
    )).rows[0];
    await client.query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
       VALUES ($1, $5, $2, 'chased', $3, $4)`,
      [
        complaintId, sentAt ? londonDateOf(new Date(sentAt)) : todayISO(),
        `Email sent: ${subject || '(no subject)'}, to ${recipients.join(', ')}`,
        sentBy || null, partyId,
      ],
    );
    await client.query('COMMIT');
    return row.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
