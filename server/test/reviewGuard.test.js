import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReview, recommendsChasing, nextDueFromThem } from '../src/services/reviewGuard.js';

const TODAY = '2026-09-28';
const chase = {
  headline: "Chase LivingCity's overdue acknowledgement by email today, quoting GC-C-RB2NGY.",
  recommended_action: 'Chase the acknowledgement.',
  next_action: { type: 'send_email', by: null },
  email: { subject: 'OVERDUE ACKNOWLEDGEMENT', body: 'Dear Sir or Madam…' },
  email_now: true,
};

test('LivingCity: raised today, acknowledgement due Thu 1 Oct — a chaser is replaced by "wait"', () => {
  const g = guardReview(chase, {
    anyOverdue: false, nextDue: { date: '2026-10-01', what: 'their acknowledgement' }, lastSentOn: '2026-09-28', today: TODAY,
  });
  assert.equal(g.next_action.type, 'wait');
  assert.equal(g.email_now, false);
  assert.match(g.headline, /^Nothing (more )?to send/);
  assert.match(g.headline, /Mon 5 Oct 2026/); // 5 working days after writing to them (later than the 1 Oct acknowledgement)
  assert.ok(g.email.body); // kept for if they miss it
});

test('58 Lawefield: we wrote to them today — no chaser, even though a date has passed', () => {
  const g = guardReview({ ...chase, headline: 'Send E.ON Next a written follow-up now.' }, {
    anyOverdue: true, nextDue: null, lastSentOn: '2026-09-28', today: TODAY,
  });
  assert.equal(g.next_action.type, 'wait');
  assert.match(g.headline, /you wrote to them on Mon 28 Sep 2026\. Wait for their reply until Mon 5 Oct 2026/);
});

test('really overdue and nothing sent lately: the chaser stands', () => {
  const g = guardReview(chase, { anyOverdue: true, nextDue: null, lastSentOn: '2026-09-01', today: TODAY });
  assert.equal(g, chase);
});

test('advice that isn’t chasing is left alone', () => {
  const stage2 = { headline: 'Ask them for a Stage 2 review, setting out each point.', next_action: { type: 'escalate_stage2' } };
  assert.equal(recommendsChasing(stage2), false);
  assert.equal(guardReview(stage2, { anyOverdue: false, today: TODAY }), stage2);
  assert.equal(recommendsChasing({ headline: 'Wait', next_action: { type: 'wait' } }), false);
});

test('the next thing due from them, across organisations', () => {
  const n = nextDueFromThem([
    { state: 'open', stage: 'stage_1', status: 'awaiting_response', response_due: '2026-10-08', org_name: 'British Gas' },
    { state: 'open', stage: 'stage_1', status: 'awaiting_ack', ack_due: '2026-10-01', org_name: 'LCS' },
  ]);
  assert.deepEqual(n, { date: '2026-10-01', what: "LCS's acknowledgement" });
});

test('sent from the system and no reply since: no email is advised, whatever it is about', () => {
  const r = {
    headline: 'Email British Gas Void Care today asking for a corrected final bill.',
    next_action: { type: 'send_email' }, email: { subject: 'Final bill', body: 'Dear…' },
  };
  const g = guardReview(r, { anyOverdue: false, nextDue: null, lastSentOn: '2026-09-29', lastTheirsOn: '2026-09-14', today: '2026-09-29' });
  assert.equal(g.next_action.type, 'wait');
  assert.match(g.headline, /you wrote to them on Tue 29 Sep 2026\. Wait for their reply until Tue 6 Oct 2026/);
});

test('they replied after our email: the ball is ours, a reply can be advised', () => {
  const r = { headline: 'Send them the tenancy agreement they asked for.', next_action: { type: 'send_email' }, email: { body: 'x' } };
  const g = guardReview(r, { anyOverdue: false, nextDue: null, lastSentOn: '2026-09-28', lastTheirsOn: '2026-09-29', today: '2026-09-29' });
  assert.equal(g, r);
});

test('our email a fortnight ago and no reply: a follow-up is allowed once the fair time has passed', () => {
  const r = { headline: 'Ask again for the corrected bill.', next_action: { type: 'send_email' }, email: { body: 'x' } };
  const g = guardReview(r, { anyOverdue: false, nextDue: null, lastSentOn: '2026-09-10', lastTheirsOn: '2026-09-01', today: '2026-09-29' });
  assert.equal(g, r);
});

test('"Do not escalate." with an email to send: completed as "send the email below", email kept', () => {
  const r = { headline: 'Do not escalate.', next_action: { type: 'send_email' }, email: { subject: 'Confirmation of nil balance', body: 'Dear…' } };
  const g = guardReview(r, { anyOverdue: true, nextDue: null, lastSentOn: '2026-09-10', lastTheirsOn: '2026-09-09', today: '2026-09-29' });
  assert.equal(g.headline, 'Do not escalate yet. Send the email below: “Confirmation of nil balance”.');
  assert.notEqual(g.email_now, false);
});

test('"Do not escalate." with nothing to send: completed as a wait, email kept ready', () => {
  const r = { headline: 'Do not escalate.', next_action: { type: 'wait' }, email: { subject: 's', body: 'Dear…' } };
  const g = guardReview(r, { anyOverdue: false, nextDue: { date: '2026-10-05', what: 'their Stage 1 response' }, lastSentOn: null, today: '2026-09-29' });
  assert.equal(g.email_now, false);
  assert.equal(g.headline, 'Do not escalate. Nothing to send now: wait for their Stage 1 response, due Mon 5 Oct 2026.');
});

test('"Don\'t chase" / "Nothing to send": the email is the one kept ready', () => {
  const w = guardReview({ headline: 'Nothing to send yet: wait until Mon 5 Oct.', email: { body: 'x' } }, { anyOverdue: false, today: '2026-09-29' });
  assert.equal(w.headline, 'Nothing to send yet: wait until Mon 5 Oct.');
  assert.equal(w.email_now, false);
  assert.equal(guardReview({ headline: "Don't chase yet.", email: { body: 'x' } }, { anyOverdue: false, today: '2026-09-29' }).email_now, false);
});

import { isStage2Request } from '../src/services/complaintRules.js';

test('an email of ours that asks for Stage 2 is read as the request; a chaser that threatens it is not', () => {
  assert.equal(isStage2Request({ subject: 'Re: 2186700 - Our complaint of 17 August 2026 (ref GC-C-BLV2WK) - request for Stage 2 review' }), true);
  assert.equal(isStage2Request({
    subject: 'Re: 2186700',
    body: 'We are not satisfied. We therefore ask that the complaint is passed to a specialist in your Complaints Team for an independent internal review (Stage 2), as set out in your procedure.',
  }), true);
  assert.equal(isStage2Request({ subject: 'Complaint update', body: 'Please escalate our complaint to Stage 2.' }), true);
  assert.equal(isStage2Request({ subject: 'Chasing our complaint', body: 'If we do not hear by Friday we will ask for Stage 2.' }), false);
  assert.equal(isStage2Request({ subject: 'Chasing', body: 'Please reply by 5 Oct. Otherwise we will request a Stage 2 review.' }), false);
  assert.equal(isStage2Request({ subject: 'Our Stage 2 review', body: 'Please confirm when we can expect your final response.' }), false);
  assert.equal(isStage2Request(null), false);
});

test('once Stage 2 has been asked for, the same request is never offered again', () => {
  const review = {
    headline: 'Request a Stage 2 review now.',
    email: { subject: 'Our complaint - request for Stage 2 review', body: 'Please escalate our complaint to Stage 2.' },
    email_now: true,
    next_action: { type: 'escalate_stage2', by: null },
  };
  const r = guardReview(review, {
    today: '2026-09-29', stage2Asked: true, nextDue: { what: 'their Stage 2 response', date: '2026-10-13' },
  });
  assert.equal(r.email, null);
  assert.equal(r.email_now, false);
  assert.equal(r.next_action.type, 'wait');
  assert.match(r.headline, /Stage 2 has been asked for\. Nothing to send now: wait for their Stage 2 response, due Tue 13 Oct 2026\./);
  // Still at Stage 1: left alone.
  assert.equal(guardReview(review, { today: '2026-09-29', stage2Asked: false }).email.subject, review.email.subject);
});

import { contactByTrack } from '../src/services/trackContact.js';
import { normaliseByOrg, guardByOrg, composeByOrg } from '../src/services/reviewGuard.js';

// CDER collecting for Liverpool City Council: the complaint to the Council,
// sent yesterday, must not hold back chasing CDER, weeks overdue.
const cder = { id: 'c1', organisation_id: 'o-cder', org_name: 'CDER Group', stage: 'stage_1', state: 'open', raised_on: '2026-07-28' };
const council = { id: 'p1', complaint_id: 'c1', organisation_id: 'o-lcc', org_name: 'Liverpool City Council', stage: 'stage_1', state: 'open', raised_on: '2026-09-29' };
const orgs = [
  { id: 'o-cder', name: 'CDER Group', complaints_email: null },
  { id: 'o-lcc', name: 'Liverpool City Council', complaints_email: null },
];
const emails = [
  { direction: 'inbound', sender_email: 'customercare@contactcder.co.uk', received_on: '2026-09-02' },
  { direction: 'inbound', sender_email: 'imogen.moore@greenco.co.uk', to_addresses: ['customercare@contactcder.co.uk'], kind: 'our_email', received_on: '2026-09-10' },
  // Sent from here, recorded against the Council: teaches its address.
  { direction: 'outbound', sender_email: 'accounts@greenco.co.uk', to_addresses: ['revenue.service@liverpool.gov.uk', 'utilities@greenco.co.uk'], party_id: 'p1', received_on: '2026-09-29' },
];

test('each organisation’s correspondence is its own', () => {
  const m = contactByTrack({ complaint: cder, parties: [council], orgs, emails, events: [], ourDomain: 'greenco.co.uk' });
  assert.deepEqual(m.get('main'), { lastSentOn: '2026-09-10', lastTheirsOn: '2026-09-02' });
  assert.deepEqual(m.get('p1'), { lastSentOn: '2026-09-29', lastTheirsOn: null });
});

test('a chaser recorded with no organisation is placed by the address it names, or else before the second organisation joined', () => {
  const events = [
    { event_date: '2026-09-29', party_id: null, note: 'Email sent: Formal complaint, to revenue.service@liverpool.gov.uk, utilities@greenco.co.uk' },
    { event_date: '2026-09-28', party_id: null, note: 'Sent the email "x" from Outlook to rates@liverpool.gov.uk.' },
    { event_date: '2026-09-16', party_id: null, note: 'Imogen chased again.' },
    { event_date: '2026-09-30', party_id: null, note: 'Chased by phone.' }, // after the Council joined: nobody's
  ];
  const m = contactByTrack({ complaint: cder, parties: [council], orgs, emails: emails.slice(0, 2), events, ourDomain: 'greenco.co.uk' });
  // The "Email sent" entry is its email's (counted from the email); an
  // Outlook note naming an address that is no further organisation's is the
  // main one's (28 Sep) — the Council's address isn't known here.
  assert.equal(m.get('main').lastSentOn, '2026-09-28');
  assert.equal(m.get('p1').lastSentOn, null);
  const known = contactByTrack({ complaint: cder, parties: [council], orgs, emails, events, ourDomain: 'greenco.co.uk' });
  assert.equal(known.get('main').lastSentOn, '2026-09-16'); // liverpool.gov.uk learnt from the Council's email
  assert.equal(known.get('p1').lastSentOn, '2026-09-29');
});

test('each organisation gets its own step, guarded by its own dates', () => {
  const tracks = [
    { ...cder, key: 'main', status: 'response_overdue', needs_chasing: true, nextAction: 'Chase.' },
    { ...council, key: 'p1', status: 'awaiting_ack', ack_due: '2026-10-02', needs_chasing: false, nextAction: 'Wait.' },
  ];
  const byOrg = normaliseByOrg([
    { org: 'Liverpool City Council', headline: 'Chase the Council for an acknowledgement now.', email: { subject: 'Chasing', body: 'Please acknowledge.' }, email_now: true, next_action: { type: 'send_email' } },
    { org: 'CDER Group Ltd', headline: 'Ask CDER for Stage 2 now.', email: { subject: 'Stage 2 request', body: 'Please escalate our complaint to Stage 2.' }, email_now: true, next_action: { type: 'escalate_stage2' } },
  ], tracks);
  assert.equal(byOrg[0].org_name, 'CDER Group');
  assert.equal(byOrg[1].org_name, 'Liverpool City Council');
  const contact = new Map([['main', { lastSentOn: '2026-09-10', lastTheirsOn: '2026-09-02' }], ['p1', { lastSentOn: '2026-09-29', lastTheirsOn: null }]]);
  const g = guardByOrg(byOrg, tracks, (k) => contact.get(k), '2026-09-29');
  // CDER: overdue and last written to on 10 Sep, so asking for Stage 2 stands.
  assert.equal(g[0].headline, 'Ask CDER for Stage 2 now.');
  assert.equal(g[0].email_now, true);
  // The Council: complained to today, acknowledgement not due until 2 Oct.
  assert.equal(g[1].email_now, false);
  assert.match(g[1].headline, /Wait for their reply until/);
  const top = composeByOrg({ headline: 'x', by_org: g, email: { body: 'y' } }, tracks);
  assert.match(top.headline, /^CDER Group: Ask CDER for Stage 2 now\. Liverpool City Council: /);
  assert.equal(top.email, null);
});

test('the Stage 2 detector never takes a chaser, a condition or a refusal for the request', () => {
  const no = [
    { subject: 'x', body: 'We therefore ask that you send your Stage 2 response within 5 working days.' },
    { subject: 'x', body: 'Please treat this as a Stage 1 complaint, not a Stage 2 one.' },
    { subject: 'x', body: 'We ask that you respond within 10 working days, failing which we shall request a Stage 2 review.' },
    { subject: 'x', body: 'This is our formal request for a Stage 1 response; a second stage review is not needed yet.' },
    { subject: 'Stage 2 escalation - chaser', body: '' },
    { subject: 'Re: Stage 2 review - awaiting your response', body: 'Please let us have your Stage 2 response.' },
  ];
  for (const e of no) assert.equal(isStage2Request(e), false, e.subject + ' ' + e.body);
  assert.equal(isStage2Request({ subject: 'x', body: 'We request a Stage 2 review of our complaint.' }), true);
  assert.equal(isStage2Request({ subject: 'x', body: 'We wish to escalate our complaint to Stage 2 of your procedure.' }), true);
});

test('an overdue Stage 2 answer is chased, not waited for, when the review repeats the request', () => {
  const r = guardReview(
    { headline: 'Ask for Stage 2.', email: { subject: 'x', body: 'Please escalate our complaint to Stage 2.' }, email_now: true },
    { today: '2026-09-29', stage2Asked: true, anyOverdue: true, nextDue: null },
  );
  assert.equal(r.email, null);
  assert.match(r.headline, /their answer is overdue: chase them for it/);
});

test('their email forwarded in by a colleague is theirs, not Greenco writing to them', () => {
  const m = contactByTrack({
    complaint: cder, parties: [council], orgs,
    emails: [...emails, { direction: 'inbound', sender_email: 'sam@greenco.co.uk', kind: 'response', sent_on: '2026-10-01', received_on: '2026-10-02', party_id: 'p1' }],
    events: [], ourDomain: 'greenco.co.uk',
  });
  assert.equal(m.get('p1').lastSentOn, '2026-09-29');
  assert.equal(m.get('p1').lastTheirsOn, '2026-10-01');
});

test('"sent it from Outlook" on the main organisation\'s step counts for the main organisation', () => {
  const m = contactByTrack({
    complaint: cder, parties: [council], orgs, emails: [],
    events: [{ event_date: '2026-09-30', party_id: null, note: 'Sent the email "Stage 2" from Outlook to CDER Group.' }],
    ourDomain: 'greenco.co.uk',
  });
  assert.equal(m.get('main').lastSentOn, '2026-09-30');
});
