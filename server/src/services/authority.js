// "We can't see that you are authorised on Mr Lau's account": the
// organisation won't deal with Greenco until it has the landlord's
// authority. Greenco often already has it (a letter of authority on this
// complaint, or on another about the same account or property), and then
// the answer is simply to send it. Only when it isn't anywhere on file does
// someone have to ask the landlord for it.
//
// Decided by rule, no AI:
//   asked     their latest email (theirs, or a colleague's forward of it)
//             says Greenco isn't authorised, or asks for authority / for
//             the account holder to get in touch (`asksForAuthority`);
//   sent      an email of ours to someone outside, since then, carried an
//             authority document;
//   on file   a document labelled as an authority (`isAuthorityDoc`) on
//             this complaint, or on one with the same account number or
//             property (copied across when it is used);
//   landlord  an email to the landlord since then (tagged LANDLORD).
// `authorityState()` is pure and tested; `loadAuthority()` does the reading.

import { query } from '../db/pool.js';
import { config } from '../config.js';
import { londonDateOf } from '../lib/dates.js';
import { ukDate } from './complaintRules.js';
import { sameProperty } from './orgMatch.js';

// The tag on emails to or from the landlord (complaint_emails.removed_org,
// complaint_events.removed_org): correspondence with the landlord is never
// Greenco writing to the organisation, or the organisation writing back, so
// every "last wrote / last heard" reader (which skips tagged rows) leaves it
// out, exactly as it does an organisation taken off the complaint.
export const LANDLORD = 'the landlord';

// What a supplier writes when it won't deal with Greenco without authority.
// A negative before "authorised/authority/permission/consent", a named
// authority document, or the account holder being asked to get in touch.
const NOT_AUTHORISED = new RegExp([
  String.raw`\b(?:not|no|cannot|can['’]?t|unable\s+to|isn['’]?t|aren['’]?t|haven['’]?t|hasn['’]?t|without)\b[^.\n]{0,80}?\b(?:authori[sz]ed|authori[sz]ation|authority|permission|consent)\b`,
  String.raw`\b(?:letter|form)\s+of\s+authority\b|\bauthority\s+form\b|\bthird[-\s]party\s+(?:authority|authori[sz]ation|consent|access)\b`,
  String.raw`\b(?:account\s*holder|bill\s*payer|named\s+customer)\b[^.\n]{0,80}?\b(?:contact|call|get\s+in\s+touch|authori[sz]e|add\s+you|give\s+(?:us\s+)?(?:permission|consent))\b`,
].join('|'), 'i');

// Text earlier in a thread, quoted under a reply, is not what this email says.
export function ownText(body) {
  const s = String(body || '');
  const cut = s.search(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,120}wrote:|Sent from my|_{5,})/i);
  return (cut > 0 ? s.slice(0, cut) : s).slice(0, 3000);
}

export const asksForAuthority = (text) => NOT_AUTHORISED.test(String(text || ''));

// A document that IS an authority: its label or name says so. "Local
// authority" (a council tax bill) is not; the words have to be about
// authorising someone to act.
const AUTH_DOC = /\b(?:letter\s+of\s+authority|authority\s+(?:letter|form|to\s+(?:act|deal|discuss|speak|manage))|authori[sz]ation(?:\s+(?:letter|form))?|authori[sz]es?\s+greenco|authori[sz]ing\s+greenco|authority\s+for\s+greenco|consent\s+(?:form|to\s+(?:act|share|discuss))|third[-\s]party\s+(?:authority|consent|authori[sz]ation)|mandate)\b|(?:^|[^a-z])loa(?:[^a-z]|$)/i;
export function isAuthorityDoc(doc) {
  const text = `${doc?.description || ''} ${doc?.filename || ''}`;
  if (/\blocal\s+authority\b/i.test(text) && !/\b(?:letter\s+of\s+authority|authori[sz]ation|authority\s+to\s+act)\b/i.test(text)) return false;
  return AUTH_DOC.test(text);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const sentOn = (e) => (ISO.test(e.analysis?.sent_on || '') ? e.analysis.sent_on : londonDateOf(new Date(e.received_at)));

// The state of it. `emails`: this complaint's, with `analysis`; `docs`: the
// authority documents on file (this complaint first), { id, filename,
// complaint_id, source_email_id }; `outbox`: sent rows { finished_at,
// attachment_ids, landlord }. Returns null when nobody asked.
export function authorityState({ complaint, emails = [], docs = [], outbox = [], ourDomain = '' }) {
  const ours = String(ourDomain || '').toLowerCase();
  const fromUs = (e) => String(e.sender_email || '').toLowerCase().endsWith(`@${ours}`);
  const isTheirs = (e) => e.direction !== 'outbound' && !e.removed_org && e.analysis?.kind !== 'our_email' &&
    (!fromUs(e) || e.analysis?.from_organisation === true);
  // Their latest email that says so. A later email of theirs that doesn't
  // (an automatic "we have your message") doesn't settle it: only the
  // authority going to them, or a person saying it is sorted, does.
  const said = (e) => `${e.analysis?.summary || ''}\n${ownText(e.body_text || e.body_preview)}`;
  // Only since the complaint was made: an imported complaint carries
  // months of earlier emails, and a request from before it was settled long
  // ago (or the complaint would never have got going).
  const since = ISO.test(String(complaint.raised_on || '')) ? complaint.raised_on : null;
  const latest = emails.filter(isTheirs).filter((e) => (!since || sentOn(e) >= since) && asksForAuthority(said(e)))
    .sort((a, b) => (sentOn(a) < sentOn(b) ? 1 : -1))[0];
  if (!latest) return null;
  const askedOn = sentOn(latest);
  if (complaint.authority_done_on && complaint.authority_done_on >= askedOn) return null;

  const authIds = new Set(docs.map((d) => d.id));
  const outside = (e) => (e.to_addresses || []).some((a) => ours && !String(a).toLowerCase().includes(`@${ours}`));
  // Sent since: an email of ours to someone outside (not the landlord) that
  // carried an authority document, or a send from here that attached one.
  const sentEmail = emails.find((e) => sentOn(e) >= askedOn && e.removed_org !== LANDLORD &&
    (e.direction === 'outbound' || fromUs(e)) && outside(e) &&
    docs.some((d) => d.source_email_id === e.id));
  const sentOut = outbox.find((o) => !o.landlord && o.finished_at && londonDateOf(new Date(o.finished_at)) >= askedOn &&
    (o.attachment_ids || []).some((id) => authIds.has(id)));
  const base = { asked_on: askedOn, asked_email_id: latest.id, party_id: latest.party_id || null };
  if (sentEmail || sentOut) {
    return { ...base, state: 'sent', sent_on: sentEmail ? sentOn(sentEmail) : londonDateOf(new Date(sentOut.finished_at)) };
  }
  const here = docs.filter((d) => d.complaint_id === complaint.id);
  const found = here[0] || docs[0] || null;
  if (found) {
    const doc = { id: found.id, filename: found.filename, complaint_id: found.complaint_id, ref_code: found.ref_code || null };
    return { ...base, state: 'on_file', doc, elsewhere: found.complaint_id !== complaint.id };
  }
  const asked = emails.filter((e) => e.removed_org === LANDLORD && e.direction === 'outbound' && sentOn(e) >= askedOn)
    .sort((a, b) => (sentOn(a) < sentOn(b) ? 1 : -1))[0];
  if (asked) return { ...base, state: 'asked_landlord', landlord_asked_on: sentOn(asked) };
  return { ...base, state: 'missing' };
}

// What the page says, and the step it means.
export function authorityStep(a, orgName) {
  if (!a) return null;
  const when = ukDate(a.asked_on);
  if (a.state === 'sent') return { action: false, text: `${orgName} said on ${when} that Greenco isn't authorised on the account; the landlord's authority was sent to them on ${ukDate(a.sent_on)}.` };
  if (a.state === 'on_file') return { action: true, text: `${orgName} said on ${when} that Greenco isn't authorised on the account. The landlord's authority is on file (${a.doc.filename}${a.elsewhere ? `, from ${a.doc.ref_code}` : ''}): send it to them.` };
  if (a.state === 'asked_landlord') return { action: false, text: `${orgName} said on ${when} that Greenco isn't authorised on the account. The landlord was asked for their authority on ${ukDate(a.landlord_asked_on)}: send it to ${orgName} when it arrives.` };
  return { action: true, text: `${orgName} said on ${when} that Greenco isn't authorised on the account, and no authority from the landlord is on file: email the landlord for it.` };
}

// The authority documents for these complaints: on each one, or on another
// complaint with the same account number or property. One query for all.
export async function authorityDocsFor(rows) {
  if (!rows.length) return new Map();
  const { rows: docs } = await query(
    `SELECT a.id, a.filename, a.description, a.complaint_id, a.source_email_id, a.uploaded_at,
            c.ref_code, c.account_numbers, c.property
       FROM complaint_attachments a JOIN complaints c ON c.id = a.complaint_id
      WHERE COALESCE(a.description, '') || ' ' || a.filename ~* '(authori[sz]|consent|mandate|loa)'
      ORDER BY a.uploaded_at DESC`,
  );
  const auth = docs.filter(isAuthorityDoc);
  const norm = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = new Map();
  for (const r of rows) {
    const mine = new Set((r.account_numbers || []).map(norm).filter((n) => n.length >= 6));
    const related = auth.filter((d) => d.complaint_id === r.id ||
      (d.account_numbers || []).some((n) => mine.has(norm(n))) ||
      (r.property && d.property && sameProperty(r.property, d.property)));
    // This complaint's own first, newest first.
    related.sort((a, b) => (a.complaint_id === r.id) === (b.complaint_id === r.id) ? 0 : a.complaint_id === r.id ? -1 : 1);
    out.set(r.id, related);
  }
  return out;
}

// The reply to the organisation with the authority attached: no AI, the
// facts on file. Warm and short; signed with the usual placeholders.
export function authorityReplyDraft(c, track, a) {
  const org = track?.org_name || c.org_name;
  const ref = track?.reference || c.reference;
  const account = (c.account_numbers || [])[0] || null;
  const subject = `${account ? `${account} - ` : ''}Landlord's authority for Greenco${ref && ref !== account ? ` (your ref ${ref})` : ''}`;
  const lines = [
    'Dear ' + org + ' team,',
    '',
    `Thank you for your email of ${letter(a.asked_on)}. As requested, please find attached the landlord's authority for Greenco to act on ${account ? `account ${account}` : 'the account'}${c.property ? ` for ${c.property}` : ''}.`,
    '',
    `Now that you have this, please could you add Greenco as authorised on the account and deal with our complaint of ${letter(c.raised_on)}${ref ? ` (your reference ${ref})` : ''}. Please quote ${c.ref_code} in your reply so it reaches us.`,
    '',
    'Kind regards,',
    '',
    '[Name]',
    '[Job title]',
    'Greenco',
  ];
  return { subject, body: lines.join('\n') };
}

// The email to the landlord asking for it.
export function landlordRequestDraft(c, track, a, landlordName) {
  const org = track?.org_name || c.org_name;
  const account = (c.account_numbers || [])[0] || null;
  const subject = `Your authority for Greenco to deal with ${org}${c.property ? ` about ${c.property}` : ''}`;
  const lines = [
    `Dear ${landlordName || '[Landlord name]'},`,
    '',
    `We are dealing with ${org} on your behalf about ${account ? `account ${account}` : 'your account'}${c.property ? ` at ${c.property}` : ''}. On ${letter(a.asked_on)} they told us they can't see that Greenco is authorised on the account, and they won't discuss it with us until they have your authority.`,
    '',
    `Could you please reply to this email confirming that you authorise Greenco to deal with ${org} on your behalf about this account? A short signed letter or a reply saying so is all we need. Alternatively, you can contact ${org} directly and ask them to add Greenco as authorised on the account.`,
    '',
    'Thank you for your help with this. As soon as we have it we will send it to them and carry on with the matter for you.',
    '',
    'Kind regards,',
    '',
    '[Name]',
    '[Job title]',
    'Greenco',
  ];
  return { subject, body: lines.join('\n') };
}

const letter = (iso) => (ISO.test(String(iso || ''))
  ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  : String(iso || ''));

// For the list, the dashboard and the page (decorateMany): each complaint's
// state, in a few queries. Only complaints with an email of theirs that may
// say so (a cheap filter on the words) are read further.
export async function authorityForMany(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const { rows: hits } = await query(
    `SELECT DISTINCT complaint_id FROM complaint_emails
      WHERE complaint_id = ANY($1::uuid[]) AND direction <> 'outbound' AND removed_org IS NULL
        AND (COALESCE(analysis->>'summary', '') || ' ' || COALESCE(left(body_text, 3000), body_preview, ''))
            ~* '(authori[sz]|permission|consent|account ?holder|bill ?payer)'`,
    [rows.map((r) => r.id)],
  );
  const want = rows.filter((r) => hits.some((h) => h.complaint_id === r.id));
  if (!want.length) return out;
  const ids = want.map((r) => r.id);
  const { rows: emails } = await query(
    `SELECT id, complaint_id, direction, sender_email, to_addresses, received_at, analysis, removed_org, party_id,
            left(body_text, 6000) AS body_text, body_preview
       FROM complaint_emails WHERE complaint_id = ANY($1::uuid[])`,
    [ids],
  );
  const { rows: outbox } = await query(
    `SELECT complaint_id, finished_at, attachment_ids, to_landlord AS landlord FROM complaint_outbox
      WHERE complaint_id = ANY($1::uuid[]) AND status = 'sent'`,
    [ids],
  );
  const docs = await authorityDocsFor(want);
  for (const r of want) {
    const a = authorityState({
      complaint: r,
      emails: emails.filter((e) => e.complaint_id === r.id),
      docs: docs.get(r.id) || [],
      outbox: outbox.filter((o) => o.complaint_id === r.id),
      ourDomain: config.complaintEmail.domain,
    });
    if (a) out.set(r.id, a);
  }
  return out;
}

// The authority document as one of THIS complaint's (an email can only
// carry its own complaint's documents): one found on another complaint about
// the same account or property is copied across, once (the hash store
// recognises a second copy), labelled with where it came from.
export async function authorityDocHere(complaintId, doc) {
  if (!doc) return null;
  if (doc.complaint_id === complaintId) return doc;
  const { saveAttachmentBuffer } = await import('./attachments.js');
  const fs = await import('node:fs/promises');
  const row = (await query('SELECT filename, mimetype, storage_path, description FROM complaint_attachments WHERE id = $1', [doc.id])).rows[0];
  if (!row) return null;
  const saved = await saveAttachmentBuffer(
    complaintId,
    { filename: row.filename, mimetype: row.mimetype, buffer: await fs.readFile(row.storage_path) },
    null,
    { description: `${row.description || "Landlord's authority"} (copied from ${doc.ref_code || 'another complaint'})` },
  );
  return { ...doc, id: saved.id, filename: saved.filename, complaint_id: complaintId };
}
