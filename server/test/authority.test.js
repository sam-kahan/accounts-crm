import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksForAuthority, isAuthorityDoc, authorityState, authorityStep, ownText, authorityReplyDraft, landlordRequestDraft, LANDLORD } from '../src/services/authority.js';
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
  assert.equal(gapIn(ask.body.replace('[Name]', 'Sam').replace('[Job title]', 'FD')), '[Landlord name]');
  assert.match(landlordRequestDraft(C, C, a, 'Mr Lau').body, /^Dear Mr Lau,/);
});

test('a request from before the complaint was made is history', () => {
  const old = { ...UW, id: 'e9', received_at: '2026-03-10T09:00:00Z' };
  assert.equal(authorityState({ complaint: C, emails: [old], docs: [], ourDomain: OURS }), null);
});
