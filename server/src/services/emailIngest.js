import { query, pool } from '../db/pool.js';
import { complaintEmailAddress } from '../config.js';

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

export function matchEmailToComplaint(email, index) {
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
  return { complaintId: null, method: 'unmatched' };
}

async function buildIndex() {
  const { rows } = await query(`SELECT id, ref_code FROM complaints`);
  return rows.map((c) => ({ ...c, email_address: complaintEmailAddress(c.ref_code) }));
}

export async function ingestEmails(emails) {
  const index = await buildIndex();
  let matched = 0;
  let inserted = 0;

  for (const e of emails) {
    const m = matchEmailToComplaint(e, index);
    // Shared catch-all: only persist emails that belong to a complaint. The
    // rest of the mailbox (spam / other teams' mail) is left untouched.
    if (!m.complaintId) continue;
    matched += 1;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
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
      if (ins.rows.length) {
        inserted += 1;
        // Reflect it on the complaint timeline too (only on first insert).
        await client.query(
          `INSERT INTO complaint_events (complaint_id, event_date, type, note)
           VALUES ($1, $2, 'note', $3)`,
          [
            m.complaintId,
            e.receivedAt.toISOString().slice(0, 10),
            `Email logged: ${e.subject || '(no subject)'} — from ${e.senderName || e.senderEmail || 'unknown'}`,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { fetched: emails.length, inserted, matched };
}

export function listComplaintEmails(complaintId) {
  return query(
    `SELECT * FROM complaint_emails WHERE complaint_id = $1 ORDER BY received_at DESC`,
    [complaintId],
  ).then((r) => r.rows);
}

// Record an email the user sent from the app against a complaint, and add a
// timeline entry. Stored as direction 'outbound' / match_method 'sent'.
export async function recordOutboundEmail({ complaintId, fromEmail, to, cc, subject, body }) {
  const recipients = [...(to || []), ...(cc || [])].filter(Boolean);
  const graphId = `out-${globalThis.crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO complaint_emails
         (complaint_id, graph_id, message_id, subject, sender_name, sender_email,
          to_addresses, body_preview, received_at, direction, match_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'outbound','sent')`,
      [
        complaintId, graphId, graphId, subject, 'You (sent from CRM)', fromEmail,
        recipients, (body || '').slice(0, 2000),
      ],
    );
    await client.query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note)
       VALUES ($1, CURRENT_DATE, 'chased', $2)`,
      [complaintId, `Email sent: ${subject || '(no subject)'} — to ${recipients.join(', ')}`],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
