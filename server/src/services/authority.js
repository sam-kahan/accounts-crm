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

// The tag on emails to or from the landlord (complaint_emails.removed_org,
// complaint_events.removed_org): correspondence with the landlord is never
// Greenco writing to the organisation, or the organisation writing back, so
// every "last wrote / last heard" reader (which skips tagged rows) leaves it
// out, exactly as it does an organisation taken off the complaint.
export const LANDLORD = 'the landlord';

// What a supplier writes when it won't deal with Greenco without authority,
// sentence by sentence. Each pattern needs the refusal itself: a negative
// with "authorised ON the account / TO discuss" (never "you are authorised"
// or "not the intended recipient"), "can't see / no record of" an
// authority, "can only speak to the account holder", "can't discuss ...
// without permission / with a third party / as you are not the account
// holder", a positive ask for consent or a letter of authority, or the
// account holder asked to get in touch TO authorise. A sentence about a
// Direct Debit, a payment or the email itself (a disclaimer) never counts.
const ACCOUNT = String.raw`(?:the|this|their|his|her|your|(?:[\w.-]+\s+){0,2}?[\w.-]+['’]s)\s+(?:[\w.-]+\s+){0,3}?account`;
const AUTH_PATTERNS = [
  // "You are not authorised on the account", "not registered as a third party
  // on this account", "not authorised to discuss it". Never "not registered
  // on the Priority Services Register".
  new RegExp(String.raw`\b(?:not|isn['’]t|aren['’]t|no\s+longer)\s+(?:been\s+)?(?:yet\s+)?(?:an?\s+)?(?:authori[sz]ed|registered)\s+(?:(?:as\s+an?\s+third\s+party\s+)?(?:on|for|to)\s+${ACCOUNT}|to\s+(?:discuss|deal|act|speak|manage)\b|as\s+(?:an?\s+)?(?:third\s+party|representative|authori[sz]ed))`, 'i'),
  /\b(?:can(?:not|['’]t)|unable\s+to|not\s+able\s+to)\s+(?:see|find|confirm|verify|locate)\b[^.]{0,60}?\b(?:authori[sz]ed|authority\s+(?:for|from|on|to\s+(?:act|discuss|deal|speak))|(?:permission|consent)\s+(?:for|from|on|to\s+(?:discuss|deal|speak|share)))\b/i,
  /\bno\s+record\s+of\b[^.]{0,40}?\b(?:authori[sz](?:ation|ed)|(?:a\s+)?letter\s+of\s+authority|(?:third[-\s]party\s+)?(?:permission|consent)\s+(?:for|from|on|to))/i,
  // "We don't have authority on file for you to discuss this account": the
  // authority FOR us / the account, never "the authority to award £50".
  /\b(?:(?:don['’]t|do\s+not|doesn['’]t|does\s+not)\s+have|haven['’]t\s+got|have\s+no)\b[^.]{0,30}?\b(?:authority|authori[sz]ation|permission|consent)\b(?!\s+to\s+(?:award|offer|approve|make|pay|issue|refund|agree|grant|backdate|waive|change))[^.]{0,40}?\b(?:you|greenco|third\s+part(?:y|ies)|account|discuss)\b/i,
  /\b(?:can(?:not|['’]t)|unable\s+to|not\s+able\s+to|won['’]t\s+be\s+able\s+to)\s+(?:discuss|disclose|deal|speak|share|go\s+into)\b[^.]{0,80}?\b(?:without|unless|until|before)\b[^.]{0,40}?\b(?:permission|consent|authori[sz]|authority)/i,
  /\b(?:can(?:not|['’]t)|unable\s+to|not\s+able\s+to)\s+(?:discuss|disclose|deal|speak|share)\b[^.]{0,80}?\b(?:as\s+you\s+are\s+not\s+the\s+(?:account\s*holder|bill\s*payer|named)|with\s+(?:a\s+)?third\s+part(?:y|ies))/i,
  // "We can only speak to the account holder": a speaking verb, never "we can
  // only backdate the bill to the date the account holder moved in".
  /\b(?:can\s+only|only\s+able\s+to|are\s+only\s+able\s+to)\s+(?:speak|discuss\s+(?:this|the|it|accounts?)|deal|talk)\b[^.]{0,20}?\b(?:to|with)\s+(?:the\s+)?(?:account\s*holder|bill\s*payer|named\s+(?:customer|person|account\s*holder))/i,
  /\b(?:we(?:\s+will|\s+would|['’]ll|['’]d)?\s+(?:need|require)|(?:please|could\s+you|can\s+you|kindly)\s+(?:send|provide|supply|forward))\b[^.]{0,60}?\b(?:letter\s+of\s+authority|authority\s+form|(?:account\s*holder|bill\s*payer)['’]s\s+(?:consent|permission|authori[sz]ation|authority)|(?:signed|written)\s+(?:authority|authori[sz]ation|consent|permission))/i,
  // "A signed letter of authority is required."
  /\b(?:letter\s+of\s+authority|authority\s+form|(?:signed|written)\s+(?:authority|authori[sz]ation|consent))\b[^.]{0,30}?\b(?:is|are|will\s+be|would\s+be)\s+(?:required|needed)/i,
  /\b(?:account\s*holder|bill\s*payer|named\s+customer)\b[^.]{0,40}?\b(?:to|will\s+need\s+to|needs?\s+to|must|should)\s+(?:contact|call|get\s+in\s+touch\s+with)\b[^.]{0,60}?\b(?:authori[sz]|add\s+(?:you|greenco|them)|as\s+(?:a\s+)?third\s+party|(?:permission|consent)\s+for|to\s+discuss)/i,
  // "Due to data protection, we are unable to discuss the account with you."
  /\b(?:data\s+protection|gdpr)\b[^.]{0,40}?\b(?:can(?:not|['’]t)|unable\s+to|not\s+able\s+to)\s+(?:discuss|disclose|share|deal|speak)\b[^.]{0,40}?\b(?:you|greenco|third\s+part(?:y|ies))\b/i,
];
const NOT_ABOUT_US = /\b(?:direct\s+debit|payment\s+(?:plan|method|card)|card\s+payment|intended\s+recipient|local\s+authority|planning\s+permission|this\s+(?:e-?mail|message)\b[^.]{0,40}\b(?:confidential|authori[sz]ed\s+by))/i;

// A disclaimer or signature block is not what the email says.
const DISCLAIMER = /\n[^\n]*\b(?:this\s+(?:e-?mail|message)\b[^\n]{0,80}\b(?:confidential|intended\s+(?:solely|only)?\s*for)|if\s+you\s+are\s+not\s+the\s+intended\s+recipient|disclaimer|confidentiality\s+notice|registered\s+(?:office|in\s+england))/i;

// Text earlier in a thread, quoted under a reply, is not what this email says.
export function ownText(body) {
  let s = String(body || '');
  const cut = s.search(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,120}wrote:|Sent from my|_{5,})/i);
  if (cut > 0) s = s.slice(0, cut);
  const d = s.search(DISCLAIMER);
  if (d > 0) s = s.slice(0, d);
  return s.slice(0, 3000);
}

// An email as a copy to pass on: every word of it, the earlier email it
// quotes included ("Yes, that's fine" means nothing without what it answers),
// with only the confidentiality-notice paragraphs taken out. Never cut short.
const NOTICE = /^[^\n]*\b(?:this\s+(?:e-?mail|message)\b[^\n]{0,80}\b(?:confidential|intended\s+(?:solely|only)?\s*for)|if\s+you\s+are\s+not\s+the\s+intended\s+recipient|disclaimer|confidentiality\s+notice)/i;
export function copyOfEmail(body) {
  return String(body || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .filter((para) => !NOTICE.test(para.trim())).join('\n\n').trim();
}

export function asksForAuthority(text) {
  // A full stop inside a sentence is not its end: "Mr. Lau", "E.ON Next".
  const s = String(text || '').replace(/\s+/g, ' ')
    .replace(/\b(Mr|Mrs|Ms|Miss|Dr|St|No|Ref|Co|e\.g|i\.e|etc)\./gi, '$1')
    .replace(/\.(?=\S)/g, '');
  const sentences = s.split(/(?<=[.!?])\s+/);
  return sentences.some((x) => !NOT_ABOUT_US.test(x) && AUTH_PATTERNS.some((re) => re.test(x)));
}

// A document that IS a landlord's authority for Greenco: a letter of
// authority, or something authorising Greenco (or a third party) to act on
// the account. Never a payment or Direct Debit "mandate"/"authorisation", a
// planning or council letter, or a consent form for something else.
const AUTH_DOC = /\b(?:letter\s+of\s+authority|authority\s+(?:letter|form|to\s+(?:act|deal|discuss|speak|manage))|authority\s+for\s+greenco|authori[sz](?:es?|ed|ing)\s+greenco|authori[sz]ation\s+(?:for\s+greenco|to\s+(?:act|deal|discuss|speak))|third[-\s]party\s+(?:authority|consent|authori[sz]ation)|consent\s+to\s+(?:act|share|discuss))\b|(?:^|[^a-z])loa(?:[^a-z]|$)/i;
const NOT_AUTH_DOC = /\b(?:direct\s+debit|payment|card|bank|planning|council\s+tax|smart\s+meter|installation|install|local\s+authority\s+(?:bill|letter|notice))\b/i;
export function isAuthorityDoc(doc) {
  const text = `${doc?.description || ''} ${doc?.filename || ''}`;
  if (NOT_AUTH_DOC.test(text) && !/\bletter\s+of\s+authority\b[^.]{0,40}\bgreenco\b|\bauthori[sz](?:es?|ed|ing)\s+greenco\b/i.test(text)) return false;
  return AUTH_DOC.test(text);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const sentOn = (e) => (ISO.test(e.analysis?.sent_on || '') ? e.analysis.sent_on : londonDateOf(new Date(e.received_at)));

// The state of it. `emails`: this complaint's, with `analysis`; `docs`: the
// authority documents on file (this complaint first), { id, filename,
// complaint_id, source_email_id }; `outbox`: sent rows { finished_at,
// attachment_ids, landlord }. Returns null when nobody asked.
// `replyDocIds`: documents made from the landlord's reply (a PDF of their
// email, labelled plainly so it never reads as a letter of authority before
// a person has read it and sent it): sending one counts as sent.
export function authorityState({ complaint, emails = [], docs = [], outbox = [], ourDomain = '', replyDocIds = [] }) {
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

  const authIds = new Set([...docs.map((d) => d.id), ...replyDocIds]);
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
  // The landlord wrote back (the draft says a reply is enough), with nothing
  // attached that reads as a letter of authority: a person reads it, and
  // sends it on (as a PDF of their email) if it gives the authority.
  // Only an email FROM the landlord: our own copy of the request coming back
  // through a watched mailbox is tagged as landlord correspondence too.
  const landlord = String(complaint.landlord_email || '').trim().toLowerCase();
  const fromLandlord = (e) => (landlord ? String(e.sender_email || '').trim().toLowerCase() === landlord : !fromUs(e));
  const reply = emails.filter((e) => e.removed_org === LANDLORD && e.direction !== 'outbound' && fromLandlord(e) && sentOn(e) >= askedOn)
    .sort((a, b) => (sentOn(a) < sentOn(b) ? 1 : -1))[0];
  if (reply) return { ...base, state: 'landlord_replied', reply_email_id: reply.id, replied_on: sentOn(reply) };
  if (asked) return { ...base, state: 'asked_landlord', landlord_asked_on: sentOn(asked) };
  return { ...base, state: 'missing' };
}

// What the page says, and the step it means.
export function authorityStep(a, orgName) {
  if (!a) return null;
  const when = ukDate(a.asked_on);
  if (a.state === 'sent') return { action: false, text: `${orgName} said on ${when} that Greenco isn't authorised on the account; the landlord's authority was sent to them on ${ukDate(a.sent_on)}.` };
  if (a.state === 'on_file') return { action: true, text: `${orgName} said on ${when} that Greenco isn't authorised on the account. The landlord's authority is on file (${a.doc.filename}${a.elsewhere ? `, from ${a.doc.ref_code}` : ''}): send it to them.` };
  if (a.state === 'landlord_replied') return { action: true, text: `${orgName} said on ${when} that Greenco isn't authorised on the account. The landlord replied on ${ukDate(a.replied_on)}: if their reply gives Greenco their authority, send it to ${orgName} (it goes as a PDF of their email).` };
  if (a.state === 'asked_landlord') return { action: false, text: `${orgName} said on ${when} that Greenco isn't authorised on the account. The landlord was asked for their authority on ${ukDate(a.landlord_asked_on)}: send it to ${orgName} when it arrives.` };
  return { action: true, text: `${orgName} said on ${when} that Greenco isn't authorised on the account, and no authority from the landlord is on file: email the landlord for it.` };
}

// The authority documents for these complaints: on each one, or on another
// complaint with the same account number or property. One query for all.
export async function authorityDocsFor(rows) {
  if (!rows.length) return new Map();
  // Only this complaint's documents, and those of complaints sharing one of
  // its account numbers (6+ characters: the same account is the same
  // customer) or EXACTLY its property, postcode and all. Never a looser
  // property match: the flats in one block have different landlords, and
  // sending a supplier another landlord's authority is a data breach.
  const norm = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const propKey = (p) => (/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i.test(String(p || '')) ? norm(p) : null);
  const accounts = [...new Set(rows.flatMap((r) => (r.account_numbers || []).map(norm)).filter((n) => n.length >= 6))];
  const props = [...new Set(rows.map((r) => propKey(r.property)).filter(Boolean))];
  const { rows: docs } = await query(
    `SELECT a.id, a.filename, a.description, a.complaint_id, a.source_email_id, a.uploaded_at,
            c.ref_code, c.account_numbers, c.property,
            -- A PDF of the landlord's reply, once it has been sent on as
            -- their authority (a person read it and chose to): an authority
            -- for every complaint about the account from then on.
            (EXISTS (SELECT 1 FROM complaint_emails e WHERE e.id = a.source_email_id
                       AND e.removed_org = $4 AND e.direction <> 'outbound')
             AND EXISTS (SELECT 1 FROM complaint_outbox o WHERE o.status = 'sent'
                       AND NOT COALESCE(o.to_landlord, false) AND a.id = ANY(o.attachment_ids))) AS sent_reply
       FROM complaint_attachments a JOIN complaints c ON c.id = a.complaint_id
      WHERE (COALESCE(a.description, '') || ' ' || a.filename) ~* '(authori[sz]|authority|consent|loa)'
        AND (a.complaint_id = ANY($1::uuid[])
             OR EXISTS (SELECT 1 FROM unnest(c.account_numbers) n WHERE upper(regexp_replace(n, '[^A-Za-z0-9]', '', 'g')) = ANY($2::text[]))
             OR upper(regexp_replace(COALESCE(c.property, ''), '[^A-Za-z0-9]', '', 'g')) = ANY($3::text[]))
      ORDER BY a.uploaded_at DESC`,
    [rows.map((r) => r.id), accounts, props, LANDLORD],
  );
  const auth = docs.filter((d) => d.sent_reply || isAuthorityDoc(d));
  const out = new Map();
  for (const r of rows) {
    const mine = new Set((r.account_numbers || []).map(norm).filter((n) => n.length >= 6));
    const myProp = propKey(r.property);
    const related = auth.filter((d) => d.complaint_id === r.id ||
      (d.account_numbers || []).some((n) => mine.has(norm(n))) ||
      (myProp && propKey(d.property) === myProp));
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
        -- A wide net (the rule itself decides), on the summary and the start
        -- of the email: a disclaimer sits at the end, and would let almost
        -- every email through to the full read.
        AND (COALESCE(analysis->>'summary', '') || ' ' || left(COALESCE(body_text, body_preview, ''), 1500))
            ~* '(authori[sz]|authority|permission|consent|account ?holder|bill ?payer|named customer)'`,
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
  const { rows: replyDocs } = await query(
    `SELECT a.id, a.complaint_id FROM complaint_attachments a JOIN complaint_emails e ON e.id = a.source_email_id
      WHERE a.complaint_id = ANY($1::uuid[]) AND e.removed_org = $2 AND e.direction <> 'outbound'`,
    [ids, LANDLORD],
  );
  for (const r of want) {
    const a = authorityState({
      complaint: r,
      emails: emails.filter((e) => e.complaint_id === r.id),
      docs: docs.get(r.id) || [],
      outbox: outbox.filter((o) => o.complaint_id === r.id),
      ourDomain: config.complaintEmail.domain,
      replyDocIds: replyDocs.filter((d) => d.complaint_id === r.id).map((d) => d.id),
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
