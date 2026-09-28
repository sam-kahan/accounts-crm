import { query } from '../db/pool.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Emails that bounced (migration 030). An email that never arrived is flagged
// until a person has looked into it: on the complaint it was about, on the
// organisation whose address it is, and on the Complaints page. No AI: a
// bounce message has a recognisable shape, and readBounce() is pure and tested.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// Who sends bounce messages, and how they are titled. A "delayed" notice is
// not a bounce (the server is still trying), so it is not flagged.
const BOUNCE_SENDER = /^(mailer-daemon|postmaster|mail-daemon|microsoftexchange[0-9a-f]*|bounces?|mdaemon)@/i;
// Only at the START of the subject, as the mail systems write it: a real
// email titled "Complaint: parcel delivery failed" must never be taken for a
// bounce (it would be flagged and not filed).
const BOUNCE_SUBJECT =
  /^\s*(undeliverable|undelivered mail|delivery status notification \(failure\)|mail delivery (failed|failure|subsystem)|returned mail|delivery has failed|failure notice|message not delivered|delivery failure|not delivered)\b/i;
const DELAY = /\b(delay(ed)?|will (retry|keep trying)|still trying|temporar(y|ily)|warning: message)\b/i;

// The address(es) a bounce says failed, in the order the usual formats give
// them. Outlook/Exchange: "Your message to x@y couldn't be delivered" or
// "Delivery has failed to these recipients or groups: x@y"; Gmail: "Your
// message wasn't delivered to x@y"; the standard report: "Final-Recipient:
// rfc822; x@y"; Postfix: "<x@y>: host … said: 550 …".
const E = "([A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)";
const FAILED_PATTERNS = [
  new RegExp(`final-recipient:\\s*rfc822;\\s*<?${E}`, 'gi'),
  new RegExp(`original-recipient:\\s*rfc822;\\s*<?${E}`, 'gi'),
  new RegExp(`message to\\s+<?${E}>?\\s+(?:couldn['’]t|could not|was not|wasn['’]t)\\s+be\\s+delivered`, 'gi'),
  new RegExp(`wasn['’]t delivered to\\s+<?${E}`, 'gi'),
  new RegExp(`(?:failed to|following recipient\\(s\\)|these recipients or groups|following addresses? had permanent fatal errors|could not be delivered to)[^@]{0,80}?<?${E}`, 'gi'),
  new RegExp(`^\\s*<${E}>:\\s`, 'gim'),
];

const clean = (a) => String(a || '').toLowerCase().replace(/^mailto:/, '').replace(/[.,;:>)\]]+$/, '');

// Is this email a bounce, and if so which address failed and why?
// `msg` is { senderEmail, subject, bodyText | bodyPreview, toAddresses }.
// Returns null (not a bounce, or a delay), or { addresses, reason }.
// `ourDomain` addresses are never the failed one (they are the sender).
// `full`: the text given is the whole message (not just the preview), so a
// subject that looks like a bounce with nothing in the body to back it up is
// NOT one. A real email titled "Not delivered: …" must never be swallowed.
export function readBounce(msg, { ourDomain = '', full = false } = {}) {
  const sender = String(msg?.senderEmail || '');
  const subject = String(msg?.subject || '');
  const body = String(msg?.bodyText || msg?.bodyPreview || '');
  const looks = BOUNCE_SENDER.test(sender) || BOUNCE_SUBJECT.test(subject);
  if (!looks) return null;
  // A delay warning says it hasn't failed yet: not flagged.
  if (!BOUNCE_SUBJECT.test(subject) && DELAY.test(`${subject} ${body.slice(0, 400)}`)) return null;
  if (/\bdelay(ed)?\b/i.test(subject)) return null;
  const ours = String(ourDomain || '').toLowerCase();
  const skip = (a) => !a.includes('@') || BOUNCE_SENDER.test(a) || (ours && a.endsWith(`@${ours}`));
  const found = [];
  for (const re of FAILED_PATTERNS) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const a = clean(m[1]);
      if (!skip(a) && !found.includes(a)) found.push(a);
    }
  }
  // Only the subject says bounce (not a mail system sending it): it counts
  // only if the text reads like a delivery report too.
  const fromMailSystem = BOUNCE_SENDER.test(sender);
  const reportLike = found.length > 0 || /final-recipient|diagnostic-code|remote server returned|status:\s*5\.\d|\b5\.\d\.\d{1,3}\b|\b55\d\b/i.test(body);
  if (!fromMailSystem && !reportLike) return full ? null : { addresses: [], reason: null, unconfirmed: true };
  if (!found.length) {
    // Nothing in a known format: the only outside address in the text, if
    // there is exactly one, is the one that failed. More than one is too
    // uncertain to name — it is still flagged, with the address unknown.
    const all = [...new Set([...body.matchAll(EMAIL_RE)].map((m) => clean(m[0])).filter((a) => !skip(a)))];
    if (all.length === 1) found.push(all[0]);
  }
  return { addresses: found.slice(0, 5), reason: reasonOf(body) };
}

// What the receiving server said: the line with the SMTP status code, which
// is what anyone looking into it needs ("550 5.1.1 User unknown").
function reasonOf(body) {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const coded = lines.find((l) => /\b(5\d\d|5\.\d{1,3}\.\d{1,3})\b/.test(l) && l.length < 400);
  const plain = lines.find((l) => /(does ?n['’]?o?t exist|not found|unknown|no such|invalid|rejected|mailbox (is )?(full|unavailable)|couldn['’]t be found|address couldn['’]t be found|blocked)/i.test(l) && l.length < 400);
  return (coded || plain || '').slice(0, 400) || null;
}

// The complaint the bounced email was about — only when that is certain: an
// email of ours on a complaint went to that address (sent from the CRM, or
// sent from Outlook and copied to a mailbox we read), the one with the
// bounced subject first, else the latest. An organisation's address alone
// is NOT enough (it may have several complaints open), so otherwise none:
// the bounce still shows on every complaint that uses the address.
async function complaintFor(address, subject) {
  const { rows } = await query(
    `SELECT complaint_id FROM complaint_emails
      WHERE complaint_id IS NOT NULL
        AND (direction = 'outbound' OR lower(sender_email) LIKE '%@' || $3)
        AND $1 = ANY (SELECT lower(x) FROM unnest(to_addresses) x)
      ORDER BY (subject IS NOT NULL AND $2::text IS NOT NULL AND position(lower(subject) in lower($2::text)) > 0) DESC,
               received_at DESC LIMIT 1`,
    [address, subject || null, String(config.complaintEmail.domain || '').toLowerCase()],
  );
  return rows[0]?.complaint_id || null;
}

// Record a bounce (once per bounce message and address). Returns the ids stored.
export async function recordBounce({ addresses, reason, source, sourceRef = null, subject = null, bouncedAt = null }) {
  const ids = [];
  const list = addresses?.length ? addresses : ['(address not stated)'];
  for (const address of list) {
    const complaintId = address.includes('@') ? await complaintFor(address, subject) : null;
    const { rows } = await query(
      `INSERT INTO email_bounces (address, reason, source, source_ref, subject, complaint_id, bounced_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()))
       ON CONFLICT (source, source_ref, address) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
      [address, reason || null, source, sourceRef, subject ? String(subject).slice(0, 300) : null, complaintId, bouncedAt],
    );
    if (!rows[0]) continue; // this bounce is already on file
    ids.push(rows[0].id);
    if (complaintId) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1, (now() AT TIME ZONE 'Europe/London')::date, 'note', $2, 'Automatic (bounced email)')`,
        [complaintId, `An email to ${address} bounced and did not arrive${reason ? ` (${reason})` : ''}. The address needs checking.`],
      );
    }
  }
  return ids;
}

// A message read from a mailbox: if it is a bounce, record it and say so (so
// the caller doesn't also treat it as a complaint email). The preview often
// stops before the address, so the full text is fetched for a bounce only.
export async function bounceFromMailbox(e, mailbox, fetchText) {
  const ourDomain = config.complaintEmail.domain;
  let b = readBounce(e, { ourDomain, full: Boolean(e.bodyText) });
  if (!b) return false;
  const sourceRef = `${mailbox || ''}:${e.messageId || e.graphId}`;
  // Read before (each check looks back over the last while): already on file.
  const seen = await query(`SELECT 1 FROM email_bounces WHERE source = 'mailbox' AND source_ref = $1 LIMIT 1`, [sourceRef]);
  if (seen.rows.length) return true;
  if ((!b.addresses.length || b.unconfirmed) && fetchText && !e.bodyText) {
    try {
      const bodyText = await fetchText(e);
      if (bodyText) b = readBounce({ ...e, bodyText }, { ourDomain, full: true });
    } catch {
      // Recorded with what the preview gives; still flagged.
    }
  }
  if (!b) return false; // the full text shows it isn't a bounce: filed as usual
  if (b.unconfirmed) return false; // couldn't confirm it: never swallow a real email
  const subject = String(e.subject || '').replace(/^(undeliverable|undelivered|returned mail|failure notice)\s*:\s*/i, '');
  // Only bounces to do with complaints are flagged here: the watched mailbox
  // (accounts@) and the catch-all carry everyone's mail, and a bounced invoice
  // to a customer is not the Complaints page's business.
  const related = [];
  for (const a of b.addresses) if (await addressRelated(a)) related.push(a);
  const aboutComplaint = /\bGC-C-[A-Z0-9]{6}\b|complain/i.test(`${subject} ${e.bodyText || e.bodyPreview || ''}`);
  if (!related.length && !(b.addresses.length === 0 && aboutComplaint)) {
    // A bounce all the same: not filed as a complaint email, just not flagged.
    return true;
  }
  await recordBounce({
    addresses: related.length ? related : [], reason: b.reason, source: 'mailbox',
    sourceRef, subject, bouncedAt: e.receivedAt || null,
  });
  return true;
}

// Is an address one the complaints section deals with: an organisation's
// complaints address, or someone on a complaint's emails?
async function addressRelated(address) {
  const { rows } = await query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM organisations WHERE lower(complaints_email) = $1)
        OR EXISTS (SELECT 1 FROM complaint_emails WHERE complaint_id IS NOT NULL
                     AND (lower(sender_email) = $1 OR $1 = ANY (SELECT lower(x) FROM unnest(to_addresses) x)))`,
    [address],
  );
  return rows.length > 0;
}

// SMTP2GO's webhook for emails the CRM sent. Its field names are read
// tolerantly (they have varied between versions); only a bounce that is
// permanent (hard) or a rejection is flagged — a soft bounce is the receiving
// server saying "not now", and SMTP2GO retries it.
export function readSmtp2goEvent(p) {
  const event = String(p?.event || p?.type || '').toLowerCase();
  const kind = String(p?.bounce || p?.bounce_type || p?.['bounce-type'] || '').toLowerCase();
  const address = clean(p?.rcpt || p?.recipient || p?.email || p?.to || '');
  const hard = event === 'hard_bounce' || event === 'hardbounce' || event === 'reject' || event === 'rejected' ||
    (event === 'bounce' && kind !== 'soft');
  if (!hard || !address.includes('@')) return null;
  return {
    address,
    reason: String(p?.message || p?.reason || p?.context || p?.['bounce-message'] || p?.description || '').slice(0, 400) || null,
    ref: String(p?.email_id || p?.['email-id'] || p?.message_id || p?.['message-id'] || p?.id || '') || null,
    subject: p?.subject || null,
  };
}

// Flagged, not yet looked into: every one, or those on one complaint /
// organisation address.
export async function openBounces({ complaintId = null, addresses = null } = {}) {
  const where = ['b.resolved_at IS NULL'];
  const params = [];
  if (complaintId || addresses) {
    const or = [];
    if (complaintId) { params.push(complaintId); or.push(`b.complaint_id = $${params.length}`); }
    if (addresses?.length) { params.push(addresses.map((a) => a.toLowerCase())); or.push(`b.address = ANY($${params.length}::text[])`); }
    where.push(`(${or.join(' OR ')})`);
  }
  return (await query(
    `SELECT b.*, c.ref_code, c.subject AS complaint_subject,
            (SELECT o.name FROM organisations o WHERE lower(o.complaints_email) = b.address LIMIT 1) AS org_name,
            (SELECT o.id FROM organisations o WHERE lower(o.complaints_email) = b.address LIMIT 1) AS organisation_id
       FROM email_bounces b LEFT JOIN complaints c ON c.id = b.complaint_id
      WHERE ${where.join(' AND ')} ORDER BY b.bounced_at DESC LIMIT 200`,
    params,
  )).rows;
}
