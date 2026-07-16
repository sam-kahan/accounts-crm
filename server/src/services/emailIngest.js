import { query, pool } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Email-to-complaint ingestion. matchEmailToComplaint is a pure function
// (precedence: ref code → their/our reference → org email → property, else
// unmatched). ingestEmails matches a batch and stores it, deduped by graph_id.
// Mirrors the refurb-manager job-email ingestion.
// ---------------------------------------------------------------------------

export function matchEmailToComplaint(email, index) {
  const hay = `${email.subject ?? ''} ${email.bodyPreview ?? ''}`.toLowerCase();
  const addrs = [email.senderEmail, ...(email.toAddresses || [])]
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  // 1. Complaint reference code (most reliable — the user puts it in the subject)
  for (const c of index) {
    if (c.ref_code && hay.includes(c.ref_code.toLowerCase())) {
      return { complaintId: c.id, method: 'ref_code' };
    }
  }
  // 2. Their reference / our reference
  for (const c of index) {
    for (const r of [c.reference, c.our_reference]) {
      if (r && r.trim().length >= 4 && hay.includes(r.trim().toLowerCase())) {
        return { complaintId: c.id, method: 'reference' };
      }
    }
  }
  // 3. Organisation's complaints email — only if it maps to exactly one complaint
  const byOrgEmail = new Map();
  for (const c of index) {
    if (!c.org_email) continue;
    const k = c.org_email.toLowerCase();
    byOrgEmail.set(k, [...(byOrgEmail.get(k) || []), c]);
  }
  for (const a of addrs) {
    const list = byOrgEmail.get(a);
    if (list && list.length === 1) return { complaintId: list[0].id, method: 'org_email' };
  }
  // 4. Property / address line
  for (const c of index) {
    const p = (c.property || '').toLowerCase().trim();
    if (p.length >= 6 && hay.includes(p)) return { complaintId: c.id, method: 'property' };
  }
  return { complaintId: null, method: 'unmatched' };
}

async function buildIndex() {
  const { rows } = await query(
    `SELECT c.id, c.ref_code, c.reference, c.our_reference, c.property,
            o.complaints_email AS org_email
       FROM complaints c
       LEFT JOIN organisations o ON o.id = c.organisation_id`,
  );
  return rows;
}

export async function ingestEmails(emails) {
  const index = await buildIndex();
  let matched = 0;
  let inserted = 0;

  for (const e of emails) {
    const m = matchEmailToComplaint(e, index);
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
        if (m.complaintId) {
          matched += 1;
          // Reflect it on the complaint timeline too.
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

export function listUnmatchedEmails() {
  return query(
    `SELECT * FROM complaint_emails WHERE complaint_id IS NULL ORDER BY received_at DESC LIMIT 100`,
  ).then((r) => r.rows);
}
