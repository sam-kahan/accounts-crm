import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksForAuthority, isAuthorityDoc, authorityState, authorityStep, ownText, authorityReplyDraft, landlordRequestDraft, LANDLORD, copyOfEmail } from '../src/services/authority.js';
import { gapIn } from '../src/lib/signature.js';

const OURS = 'greenco.co.uk';
const C = { id: 'c1', org_name: 'Utility Warehouse', raised_on: '2026-08-17', ref_code: 'GC-C-BLV2WK', reference: '2186700', account_numbers: ['2186700'], property: '15 Jones Street, M6 5LP' };
// Utility Warehouse, 3 Oct 2026 (as the AI summarised it).
const UW = {
  id: 'e1', direction: 'inbound', sender_email: 'homemovers@support.uw.co.uk', received_at: '2026-10-03T09:00:00Z',
  analysis: { kind: 'request_info', from_organisation: true, summary: "Utility Warehouse apologises for the delay but says it cannot see that Imogen is authorised on Mr Lau's account. It asks the account holder to contact them to arrange authorisation before it will deal with the query." },
  body_text: 'Thanks for your email.',
};
const LOA = { id: 'd1', filename: 'Mr Lau letter of authority.pdf', complaint_id: 'c1', source_email_id: 'e0' };

test('what a supplier writes when Greenco is not authorised', () => {
  assert.ok(asksForAuthority(UW.analysis.summary));
  assert.ok(asksForAuthority('We are unable to discuss this account without the account holder’s permission.'));
  assert.ok(asksForAuthority('Please send us a letter of authority signed by the account holder.'));
  assert.ok(asksForAuthority('The account holder will need to call us to add you to the account.'));
  assert.ok(!asksForAuthority('Thank you, we have added Greenco as an authorised party on the account.'));
  assert.ok(!asksForAuthority('Your final bill is attached. The balance is £422.55.'));
});

test('an earlier email quoted under a reply is not what this email says', () => {
  assert.equal(ownText('Thanks, received.\n\nOn 3 Oct 2026, UW wrote:\n> we cannot see you are authorised'), 'Thanks, received.');
});

test('which documents are an authority', () => {
  assert.ok(isAuthorityDoc({ filename: 'scan.pdf', description: "Letter from Mr Lau authorising Greenco to deal with Utility Warehouse" }));
  assert.ok(isAuthorityDoc({ filename: 'LOA - 15 Jones St.pdf' }));
  assert.ok(isAuthorityDoc({ filename: 'x.pdf', description: 'Signed letter of authority for 15 Jones Street' }));
  assert.ok(!isAuthorityDoc({ filename: 'bill.pdf', description: 'Council tax bill from the local authority, Salford City Council' }));
  assert.ok(!isAuthorityDoc({ filename: 'GreencoScan_202607231843.pdf', description: 'Utility Warehouse gas bill dated 9 Jul 2026' }));
});

test('on file and not sent: send it to them now', () => {
  const a = authorityState({ complaint: C, emails: [UW], docs: [LOA], ourDomain: OURS });
  assert.equal(a.state, 'on_file');
  assert.equal(a.asked_on, '2026-10-03');
  assert.equal(a.doc.id, 'd1');
  const step = authorityStep(a, 'Utility Warehouse');
  assert.equal(step.action, true);
  assert.match(step.text, /The landlord's authority is on file \(Mr Lau letter of authority\.pdf\): send it to them\./);
});

test('on another complaint about the same account: still on file, from there', () => {
  const a = authorityState({ complaint: C, emails: [UW], docs: [{ ...LOA, complaint_id: 'c9', ref_code: 'GC-C-OTHER1' }], ourDomain: OURS });
  assert.equal(a.state, 'on_file');
  assert.equal(a.elsewhere, true);
  assert.match(authorityStep(a, 'UW').text, /from GC-C-OTHER1/);
});

test('sent since they asked: nothing to do', () => {
  // Our email to them, after their request, carrying the authority.
  const ours = { id: 'e2', direction: 'inbound', sender_email: 'oliver@greenco.co.uk', to_addresses: ['homemovers@support.uw.co.uk'], received_at: '2026-10-05T10:00:00Z', analysis: { kind: 'our_email' } };
  const a = authorityState({ complaint: C, emails: [UW, ours], docs: [{ ...LOA, source_email_id: 'e2' }], ourDomain: OURS });
  assert.equal(a.state, 'sent');
  assert.equal(authorityStep(a, 'UW').action, false);
  // Forwarded only to the complaint's own address: not sent to them.
  const internal = { ...ours, to_addresses: ['complaint-blv2wk@greenco.co.uk'] };
  assert.equal(authorityState({ complaint: C, emails: [UW, internal], docs: [{ ...LOA, source_email_id: 'e2' }], ourDomain: OURS }).state, 'on_file');
  // Or sent from here with it attached.
  const b = authorityState({ complaint: C, emails: [UW], docs: [LOA], outbox: [{ finished_at: '2026-10-06T09:00:00Z', attachment_ids: ['d1'] }], ourDomain: OURS });
  assert.equal(b.state, 'sent');
});

test('none on file: ask the landlord; asked: wait for them', () => {
  const a = authorityState({ complaint: C, emails: [UW], docs: [], ourDomain: OURS });
  assert.equal(a.state, 'missing');
  assert.match(authorityStep(a, 'Utility Warehouse').text, /no authority from the landlord is on file: email the landlord for it/);
  const asked = { id: 'e3', direction: 'outbound', removed_org: LANDLORD, to_addresses: ['lau@gmail.com'], received_at: '2026-10-06T11:00:00Z' };
  const b = authorityState({ complaint: C, emails: [UW, asked], docs: [], ourDomain: OURS });
  assert.equal(b.state, 'asked_landlord');
  assert.equal(authorityStep(b, 'UW').action, false);
});

test('a later email of theirs that says nothing about it does not settle it; "Already sorted" does', () => {
  const ack = { id: 'e4', direction: 'inbound', sender_email: 'noreply@uw.co.uk', received_at: '2026-10-04T09:00:00Z', analysis: { kind: 'acknowledgement', summary: 'Automatic reply: we aim to respond within 5 working days.' } };
  assert.equal(authorityState({ complaint: C, emails: [UW, ack], docs: [], ourDomain: OURS }).state, 'missing');
  assert.equal(authorityState({ complaint: { ...C, authority_done_on: '2026-10-06' }, emails: [UW], docs: [], ourDomain: OURS }), null);
  // Our own email talking about authority is never their request.
  const mine = { ...UW, id: 'e5', sender_email: 'sam@greenco.co.uk', analysis: { kind: 'our_email', summary: 'We cannot see why you say we are not authorised.' } };
  assert.equal(authorityState({ complaint: C, emails: [mine], docs: [], ourDomain: OURS }), null);
});

test('the drafts: no gap in the reply; the landlord email needs their name', () => {
  const a = authorityState({ complaint: C, emails: [UW], docs: [LOA], ourDomain: OURS });
  const reply = authorityReplyDraft(C, C, a);
  assert.match(reply.body, /Thank you for your email of 3 October 2026\. As requested, please find attached the landlord's authority for Greenco to act on account 2186700/);
  assert.equal(gapIn(reply.subject, reply.body.replace('[Name]', 'Sam').replace('[Job title]', 'FD')), null);
  const ask = landlordRequestDraft(C, C, a, null);
  assert.equal(gapIn('', ask.body.replace('[Name]', 'Sam').replace('[Job title]', 'FD')), '[Landlord name]');
  assert.match(landlordRequestDraft(C, C, a, 'Mr Lau').body, /^Dear Mr Lau,/);
});

test('a request from before the complaint was made is history', () => {
  const old = { ...UW, id: 'e9', received_at: '2026-03-10T09:00:00Z' };
  assert.equal(authorityState({ complaint: C, emails: [old], docs: [], ourDomain: OURS }), null);
});

import { couldChangeDate, planFromAnalysis } from '../src/services/emailAnalysis.js';

test('an authority request is not their response: it files itself, whatever stage the subject says', () => {
  const a = { kind: 'request_info', confidence: 'medium', from_organisation: true, sent_on: '2026-10-03',
    summary: "Utility Warehouse apologises for the delay but says it cannot see that Imogen is authorised on Mr Lau's account. It asks the account holder to contact them to arrange authorisation before it will deal with the query. It does not address the Stage 2 request or the billing points." };
  const text = 'Re: 2186700 - Our complaint of 17 August 2026 (ref GC-C-BLV2WK) - request for Stage 2 review\nWe cannot see that Imogen is authorised on the account.';
  assert.equal(couldChangeDate(a, text), false);
  // A response that also mentions authority still waits for a person.
  assert.equal(couldChangeDate({ ...a, summary: `${a.summary} This is our final response.` }, text), true);
  // And a plain mention of Stage 2 with no authority in it still waits, as before.
  assert.equal(couldChangeDate({ kind: 'request_info', summary: 'They ask about the Stage 2 request.' }, ''), true);
  const track = { stage: 'stage_2', raised_on: '2026-08-17', stage_started_on: '2026-09-28', acknowledged_on: '2026-08-22', state: 'open' };
  const plan = planFromAnalysis(track, a, { today: '2026-10-06', text });
  assert.equal(plan.auto, true);
  assert.equal(plan.reviewedAs, 'correspondence');
});

test('a disclaimer, a direct debit or a "you are now authorised" is never an authority request', () => {
  for (const t of [
    'If you are not the intended recipient you are not authorised to use, copy or disclose it',
    'This message has not been authorised by the company',
    'No further action is required, you are now authorised on the account.',
    'We have not received authorisation for the direct debit.',
    'If you have any questions, the account holder should contact us.',
    'There is no need for a letter of authority, we have it.',
    'If you are not happy the bill payer can contact the Ombudsman.',
  ]) assert.equal(asksForAuthority(t), false, t);
  assert.ok(asksForAuthority('You are not registered as a third party on this account.'));
  // The disclaimer under a reply is cut off before it is read.
  const e = { ...UW, analysis: { kind: 'other', from_organisation: true, summary: 'Your final bill is attached.' }, body_text: 'Your final bill is attached.\n\nThis email is confidential and intended solely for the addressee. If you are not the intended recipient you are not authorised to read it.' };
  assert.equal(authorityState({ complaint: C, emails: [e], docs: [], ourDomain: OURS }), null);
});

test('payment and other consents are not a landlord’s authority', () => {
  for (const f of ['Direct Debit mandate.pdf', 'Payment authorisation receipt.pdf', 'Card payment authorization.png', 'Planning authorisation.pdf', 'Consent form - smart meter install.pdf', 'Local authority letter of authority council tax.pdf']) {
    assert.equal(isAuthorityDoc({ filename: f }), false, f);
  }
});

test('the landlord replied: send their reply on', () => {
  const asked = { id: 'e3', direction: 'outbound', removed_org: LANDLORD, to_addresses: ['lau@gmail.com'], received_at: '2026-10-06T11:00:00Z' };
  const reply = { id: 'e6', direction: 'inbound', removed_org: LANDLORD, sender_email: 'lau@gmail.com', received_at: '2026-10-06T15:00:00Z', analysis: {} };
  const a = authorityState({ complaint: C, emails: [UW, asked, reply], docs: [], ourDomain: OURS });
  assert.equal(a.state, 'landlord_replied');
  assert.equal(a.reply_email_id, 'e6');
  assert.equal(authorityStep(a, 'UW').action, true);
});

test('only the landlord’s own email is their reply; sending the PDF of it settles it', () => {
  const asked = { id: 'e3', direction: 'outbound', removed_org: LANDLORD, to_addresses: ['lau@gmail.com'], received_at: '2026-10-06T11:00:00Z' };
  // Our own request, come back through a watched mailbox.
  const copy = { id: 'e4', direction: 'inbound', removed_org: LANDLORD, sender_email: 'sam@greenco.co.uk', to_addresses: ['lau@gmail.com'], received_at: '2026-10-06T11:01:00Z', analysis: {} };
  const someone = { id: 'e5', direction: 'inbound', removed_org: LANDLORD, sender_email: 'other@gmail.com', received_at: '2026-10-06T12:00:00Z', analysis: {} };
  const withLandlord = { ...C, landlord_email: 'Lau@gmail.com' };
  assert.equal(authorityState({ complaint: C, emails: [UW, asked, copy], ourDomain: OURS }).state, 'asked_landlord');
  assert.equal(authorityState({ complaint: withLandlord, emails: [UW, asked, someone], ourDomain: OURS }).state, 'asked_landlord');
  const reply = { id: 'e6', direction: 'inbound', removed_org: LANDLORD, sender_email: 'lau@gmail.com', received_at: '2026-10-06T15:00:00Z', analysis: {} };
  assert.equal(authorityState({ complaint: withLandlord, emails: [UW, asked, reply], ourDomain: OURS }).state, 'landlord_replied');
  // The PDF of their reply is not "a letter of authority on file" until sent.
  assert.equal(isAuthorityDoc({ filename: 'Landlord authority - email of 6 Oct 2026.pdf', description: "The landlord's email of Tue 6 Oct 2026, as a PDF to send on as their reply" }), false);
  const sent = { finished_at: '2026-10-07T09:00:00Z', attachment_ids: ['p1'] };
  assert.equal(authorityState({ complaint: withLandlord, emails: [UW, asked, reply], outbox: [sent], replyDocIds: ['p1'], ourDomain: OURS }).state, 'sent');
});

// How organisations actually word it, and the sentences that only look like it.
const AUTH_YES = [
 "Utility Warehouse apologises for the delay but says it cannot see that Imogen is authorised on Mr Lau's account. It asks the account holder to contact them to arrange authorisation.",
 "Hi, sorry for the delay. We cannot see that Imogen is authorised on Mr Lau's account.",
 "We are unable to discuss the account without the account holder's permission.",
 "Please send us a letter of authority signed by the account holder.",
 "The account holder will need to call us to add you to the account.",
 "You are not authorised on the account.", "You are not registered as a third party on this account.",
 "We are unable to discuss this account with you as you are not the account holder.",
 "For data protection reasons we can only speak to the account holder.",
 "We need the account holder's consent before we can discuss the account.",
 "We don't have authority on file for you to discuss this account.",
 "We'll need a letter of authority from the landlord.",
 "Could you send us a signed letter of authority?",
 "We can't discuss this without the account holder's permission.",
 "Due to GDPR we cannot discuss the account with a third party.",
 "We have no record of you being authorised on this account.",
];
const AUTH_NO = [
 "If you are not the intended recipient you are not authorised to use, copy or disclose it",
 "This message has not been authorised by the company",
 "No further action is required, you are now authorised on the account.",
 "We have not received authorisation for the direct debit.",
 "If you have any questions, the account holder should contact us.",
 "There is no need for a letter of authority, we have it.",
 "If you are not happy the bill payer can contact the Ombudsman.",
 "Thank you, we can now see you are authorised on the account.",
 "Greenco is registered on the account as a third party.",
 "you are authorised to discuss the account.", "Mr Lau is registered on the account since 2021.",
 "We are unable to discuss your complaint until we receive the meter readings, unless the account holder confirms the move date.",
 "The account holder must contact us to set up a payment plan with consent of the court.",
 "We don't have a direct debit authorisation on file.", "Your final bill is attached.",
];
test('authority requests: the wordings seen, and the look-alikes', () => {
  for (const s of AUTH_YES) assert.ok(asksForAuthority(s), s);
  for (const s of AUTH_NO) assert.equal(asksForAuthority(s), false, s);
});

test('a gap is a gap in capitals too; a reference or mail tag is not', () => {
  for (const g of ['[NAME]', '[DATE]', '[AMOUNT]', '[ACCOUNT NUMBER]', '[XX/XX/XXXX]', '[£___]', '[Case notes here]',
    '[Re-attach the bill]', '[External link]', '[Ref: insert]', '[Our email of 16 September]', '[TBC]']) assert.equal(gapIn('', `Hi ${g}`), g, g);
  for (const ok of ['[GC-C-BLV2WK]', '[EXTERNAL]', '[Ticket #12345]', '[850123456]', '[sic]', '[image: logo]', '[Ref: AB-1234]', '[PDF]'])
    assert.equal(gapIn('', `Hi ${ok}`), null, ok);
  assert.equal(gapIn('Re: your complaint [GC-C-BLV2WK]', ''), null);
  assert.equal(gapIn('Complaint about [NAME]', ''), '[NAME]');
});

test('review of 7 Oct: wordings with abbreviations, the passive and "would"; look-alikes about other things', () => {
  for (const s of ["We're unable to discuss the E.ON Next account without the account holder's permission.",
    "We are unable to discuss Mr. Lau's account without his consent.", 'Due to data protection, we are unable to discuss the account with you.',
    'We would need a letter of authority before we can discuss this.', 'A signed letter of authority is required.',
    "Imogen is not authorised on Mr Lau's account."]) assert.ok(asksForAuthority(s), s);
  for (const s of ['We can only backdate the bill to the date the account holder moved in.', 'We can only issue the refund to the bill payer.',
    'I do not have the authority to award compensation above £50.', "We don't have any information from the local authority about this.",
    'The property is not registered on the Priority Services Register.', 'We are unable to confirm whether planning permission was granted.'])
    assert.equal(asksForAuthority(s), false, s);
});

test('gaps: placeholders in capitals and blank figures are gaps; tags and labelled references are not; nor a file name', () => {
  for (const g of ['[POSTCODE]', '[LANDLORD]', '[REFERENCE]', '[SUPPLIER]', '[MPAN]', '[EMAIL]', '[PHONE]', '[00/00/0000]', '[000000]', '[0.00]', '[Account number]'])
    assert.equal(gapIn('', `Hi ${g}`), g, g);
  for (const ok of ['[Case Ref: CAS-12345-ABCD]', '[ ref:_00D4J2Ez._5008d1abcde:ref ]', '[Ticket #12345 - Your complaint]', '[EXTERNAL EMAIL]',
    '[OFFICIAL-SENSITIVE]', '[CRM:0012345]', '[Your reference: 12345]', '[Account number: 850123456]']) assert.equal(gapIn('', `Hi ${ok}`), null, ok);
  assert.equal(gapIn('[Account number: 850123456] your complaint', ''), null);
  assert.equal(gapIn('', 'Body\n\nAttached: Email 16 Sep 2026 - [EXTERNAL EMAIL] RE Your complaint.pdf.'), null);
});

test('the landlord’s reply goes on whole: only the confidentiality notice comes out', () => {
  const body = 'Yes, happy for Greenco to deal with it.\n\nThis email is confidential and intended solely for the addressee.\n\nFrom: Greenco\nSubject: Your authority\n\nCould you confirm you authorise Greenco about account 99887766?';
  const out = copyOfEmail(body);
  assert.match(out, /^Yes, happy/);
  assert.match(out, /account 99887766\?$/);
  assert.doesNotMatch(out, /confidential/);
});
