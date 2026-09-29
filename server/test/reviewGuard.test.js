import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReview, recommendsChasing, nextDueFromThem, chaseHeldUntil, recommendsReferral } from '../src/services/reviewGuard.js';

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

import { isStage2Request, missedStage2Requests } from '../src/services/complaintRules.js';

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

test('a chaser that also asks for Stage 2 is the request: saying what they have not done is a reason, not a condition', () => {
  const yes = [
    { subject: 'Overdue Stage 1 response and request for Stage 2 review', body: 'As you have not yet responded to our complaint within the timescale in your procedure, we request that it is escalated to Stage 2.' },
    { subject: 'Chasing our complaint', body: 'We have still not received your Stage 1 response, so please escalate our complaint to Stage 2 of your procedure.' },
    { subject: 'x', body: 'No response has been received. We therefore ask that the complaint is passed to Stage 2 for review.' },
  ];
  for (const e of yes) assert.equal(isStage2Request(e), true, e.body);
  const no = [
    { subject: 'x', body: 'If you have not responded by Friday, please escalate our complaint to Stage 2.' },
    { subject: 'x', body: 'Should you not reply by 5 Oct, please escalate our complaint to Stage 2.' },
    { subject: 'x', body: 'We have not received a response; please do not escalate our complaint to Stage 2 yet.' },
    { subject: 'x', body: 'Before we request a Stage 2 review, please let us have your Stage 1 response.' },
  ];
  for (const e of no) assert.equal(isStage2Request(e), false, e.body);
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

test('chaseHeldUntil: overdue but just written to is "wait", by the same rule as the next step', () => {
  // Wrote to them Tue 29 Sep, no reply: held for 5 working days, to Tue 6 Oct.
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-29', today: '2026-09-29' }), '2026-10-06');
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-29', today: '2026-10-05' }), '2026-10-06');
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-29', today: '2026-10-06' }), null);
  // Written lately even though they replied since: still given the gap.
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-29', lastTheirsOn: '2026-09-30', today: '2026-10-01' }), '2026-10-06');
  // They replied after our last email, long enough ago: chase now.
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-15', lastTheirsOn: '2026-09-18', today: '2026-09-29' }), null);
  // Never written to: nothing holds it.
  assert.equal(chaseHeldUntil({ lastSentOn: null, today: '2026-09-29' }), null);
  // Greenco wrote last and their own deadline is later: held to that.
  assert.equal(chaseHeldUntil({ lastSentOn: '2026-09-29', nextDue: { date: '2026-10-09' }, today: '2026-10-07' }), '2026-10-09');
});

test('the Stage 2 request is recognised however it is politely worded', () => {
  const yes = [
    'We have not received your Stage 1 response, which was due on 23 July 2026. We therefore ask that you now escalate our complaint to Stage 2 of your complaints procedure.',
    'As we have had no response, we would like our complaint to be escalated to Stage 2 of your complaints procedure.',
    'Please treat this email as our formal request for a Stage 2 review.',
    'We are now requesting that the complaint is escalated to Stage 2.',
    'We now wish to escalate this complaint to Stage 2.',
    'Please escalate this complaint to stage two of your procedure and confirm the date by which we can expect your response.',
    'We request that our complaint be escalated to the second stage of your complaints procedure.',
    'Please accept this email as our request to escalate the complaint to Stage 2.',
    'Given the delay, we are escalating our complaint to Stage 2 of your complaints procedure.',
    'We ask that this is now considered at Stage 2 of your complaints process.',
    'Could you please escalate our complaint to Stage 2.',
    'We would be grateful if you could escalate our complaint to Stage 2.',
    'Kindly escalate this complaint to Stage 2.',
    'We now formally request a Stage 2 review of our complaint.',
    'We are writing to request that our complaint is escalated to Stage 2.',
    'We are writing to ask for our complaint to be reviewed at Stage 2.',
  ];
  for (const b of yes) assert.equal(isStage2Request({ subject: 'x', body: b }), true, b);
  const no = [
    'Failing a response by 6 October, we would like our complaint to be escalated to Stage 2.',
    'Please escalate our complaint to Stage 2 if you do not reply by Friday.',
    'We asked for a Stage 2 review on 1 September and have heard nothing.',
    'Please confirm you received our request to escalate the complaint to Stage 2.',
    'Please let us have your Stage 2 response by 5 October.',
  ];
  for (const b of no) assert.equal(isStage2Request({ subject: 'x', body: b }), false, b);
});

test('missedStage2Requests: a request we sent that left the complaint at Stage 1', () => {
  const main = { party_id: null, org_name: 'Liverpool City Council', stage: 'stage_1', state: 'open', raised_on: '2026-07-09' };
  const ask = { id: 'e1', subject: 'Request for Stage 2 review', body: 'Please escalate our complaint to Stage 2.', sent_on: '2026-09-29', party_id: null, from_here: true };
  const [m] = missedStage2Requests([main], [ask]);
  assert.equal(m.email_id, 'e1');
  assert.equal(m.sent_on, '2026-09-29');
  assert.equal(m.certain, true);
  // Already moved on, or a person put it back to Stage 1 afterwards: nothing.
  assert.deepEqual(missedStage2Requests([{ ...main, stage: 'stage_2' }], [ask]), []);
  assert.deepEqual(missedStage2Requests([main], [ask], [{ type: 'note', party_id: null, event_date: '2026-09-30', note: 'Details corrected: stage: Stage 2 → Stage 1' }]), []);
  // A chaser that only threatens it: no prompt.
  const threat = { ...ask, id: 'e2', subject: 'Chasing', body: 'If we do not hear by Friday we will escalate our complaint to Stage 2.' };
  assert.deepEqual(missedStage2Requests([main], [threat]), []);
  // Speaks of escalating without asking in so many words: offered, never certain.
  const vague = { ...ask, id: 'e3', subject: 'Our complaint', body: 'This now needs escalating to Stage 2 of your procedure.', from_here: false };
  assert.equal(missedStage2Requests([main], [vague])[0].certain, false);
  // A later email that only mentions it never replaces a certain request.
  const [both] = missedStage2Requests([main], [{ ...ask, sent_on: '2026-09-20' }, { ...vague, sent_on: '2026-09-25' }]);
  assert.equal(both.email_id, 'e1');
  // Undone by a person afterwards: not offered again.
  assert.deepEqual(missedStage2Requests([main], [ask], [{ type: 'note', party_id: null, event_date: '2026-09-30', note: 'Automatic record from the email "x" undone (back to Stage 1; stage start date back to Wed 1 Jul 2026).' }]), []);
  // An Undo of something else, whose subject happens to mention Stage 2, doesn't count.
  assert.equal(missedStage2Requests([main], [ask], [{ type: 'note', party_id: null, event_date: '2026-09-30', note: 'What Sam recorded from the email "Re: Stage 2 complaint" undone (date acknowledged back to blank).' }]).length, 1);
  // A chaser that doesn't mention Stage 2: nothing.
  assert.deepEqual(missedStage2Requests([main], [{ ...ask, subject: 'Chasing', body: 'Please reply by Friday.' }]), []);
  // Two organisations and not sent from here with none named: a person says whose.
  const cder = { party_id: 'p1', org_name: 'CDER Group', stage: 'stage_1', state: 'open', raised_on: '2026-08-01' };
  assert.deepEqual(missedStage2Requests([main, cder], [{ ...ask, from_here: false }]), []);
  // Sent from here with no organisation recorded, two on the complaint: offered, never acted on.
  const unplaced = missedStage2Requests([main, cder], [{ ...ask, from_here: true }]);
  assert.equal(unplaced.length, 1);
  assert.equal(unplaced[0].certain, false);
  assert.equal(missedStage2Requests([main, cder], [{ ...ask, party_id: 'p1' }])[0].org_name, 'CDER Group');
});

test('the AI review never sends anyone to the ombudsman too early', () => {
  const notYet = { open: false, from: '2026-10-04', why: 'the Energy Ombudsman can’t take it until Sun 4 Oct 2026 (8 weeks after the complaint was made on Sun 9 Aug 2026)' };
  const review = {
    headline: 'Refer the complaint to the Energy Ombudsman now.',
    next_action: { type: 'refer_ombudsman' },
    email: { subject: 'Referral to the Energy Ombudsman', body: 'We wish to refer our complaint.' },
    email_now: true,
  };
  const g = guardReview(review, { today: '2026-09-29', referral: notYet });
  assert.equal(g.headline, `Not the ombudsman yet: ${notYet.why}.`);
  assert.equal(g.next_action.type, 'wait');
  assert.equal(g.next_action.by, '2026-10-04');
  assert.equal(g.email_now, false);
  // Mixed advice keeps the part that is right.
  const mixed = guardReview({ headline: 'Chase E.ON for their Stage 1 response. You can also refer it to the Energy Ombudsman now.' },
    { today: '2026-09-29', referral: notYet, anyOverdue: true });
  assert.match(mixed.headline, /^Chase E\.ON for their Stage 1 response\. Not the ombudsman yet: /);
  // One sentence, two actions: the referral goes, the email stays.
  const bg = guardReview({ headline: 'Refer the complaint to the Energy Ombudsman by 6 October 2026 and email British Gas today.' },
    { today: '2026-09-29', referral: { open: false, why: 'this imported complaint hasn’t been checked' }, anyOverdue: true });
  assert.equal(bg.headline, 'Email British Gas today. Not the ombudsman yet: this imported complaint hasn’t been checked.');
  // Once it can go, the advice stands.
  assert.equal(guardReview(review, { today: '2026-10-05', referral: { open: true } }).headline, review.headline);
  // Saying when it could go is not advice to go now.
  assert.equal(recommendsReferral({ headline: 'Wait until 13 Oct; if they still haven’t replied, refer it to the ombudsman.' }), false);
  assert.equal(recommendsReferral({ headline: 'You can refer it to the Energy Ombudsman now.' }), true);
});

test('referral advice is caught however the sentence goes on', () => {
  const now = [
    'Refer the complaint to the Energy Ombudsman now, before the 12-month limit runs out.',
    'Refer it to the Energy Ombudsman now: they have ignored us after two chasers.',
    'You can refer it to the Energy Ombudsman now.',
    'Refer the complaint to the Energy Ombudsman by 6 October 2026 and email British Gas today.',
  ];
  for (const h of now) assert.equal(recommendsReferral({ headline: h }), true, h);
  const later = [
    'Wait until 13 Oct; if they still haven’t replied, refer it to the ombudsman.',
    'Don’t refer it to the Energy Ombudsman yet.',
    'Once 8 weeks have passed, refer it to the Energy Ombudsman.',
    'Refer it to the Energy Ombudsman from 4 Oct 2026.',
    'Refer it to the Energy Ombudsman if they don’t reply by Friday.',
    'Not the ombudsman yet: they can’t take it until Sun 4 Oct 2026.',
  ];
  for (const h of later) assert.equal(recommendsReferral({ headline: h }), false, h);
});

test('a Stage 2 threat, condition or question is never taken for the request', () => {
  const no = [
    'Please escalate this to Stage 2 if you cannot resolve it by Friday.',
    'Please escalate this to Stage 2 unless you can resolve it this week.',
    'Please escalate our complaint to Stage 2 if we have heard nothing by 5 October.',
    'Please escalate our complaint to Stage 2 should you be unable to resolve it.',
    'Please advise how we request a Stage 2 review.',
    'We would like to know how to escalate to stage 2.',
  ];
  for (const b of no) assert.equal(isStage2Request({ subject: 'x', body: b }), false, b);
  assert.equal(isStage2Request({ subject: 'x', body: 'We would be grateful if you could escalate our complaint to Stage 2.' }), true);
});

import { reviewOutrun } from '../src/services/complaintRules.js';
test('a review is out of date once its "wait until" has passed or a referral opened', () => {
  const tracks = [{ referral: { open: false } }];
  assert.equal(reviewOutrun({ next_action: { type: 'wait', by: '2026-10-09' } }, tracks, '2026-10-09'), false);
  assert.equal(reviewOutrun({ next_action: { type: 'wait', by: '2026-10-09' } }, tracks, '2026-10-10'), true);
  assert.equal(reviewOutrun({ by_org: [null, { next_action: { type: 'wait', by: '2026-10-01' } }] }, tracks, '2026-10-02'), true);
  assert.equal(reviewOutrun({ referral_open: [false] }, [{ referral: { open: true } }], '2026-10-02'), true);
  assert.equal(reviewOutrun({ referral_open: [false] }, tracks, '2026-10-02'), false);
});

test('each organisation\'s step lines up with the organisations as they are now', () => {
  const tracks = [{ key: 'main', org_name: 'A', stage: 'stage_1', state: 'open' }, { key: 'p2', org_name: 'C', stage: 'stage_1', state: 'open' }];
  // B (p1) was taken off since the review was written.
  const stored = [{ key: 'main', headline: 'A step' }, { key: 'p1', headline: 'B step' }, { key: 'p2', headline: 'C step' }];
  const out = guardByOrg(stored, tracks, () => ({}));
  assert.equal(out.length, 2);
  assert.equal(out[1].key, 'p2');
  const composed = composeByOrg({ headline: 'x', caution: 'about B', guarded: 'x', next_action: { type: 'wait' }, by_org: out }, tracks);
  assert.equal(composed.caution, null);
  assert.equal(composed.next_action, null);
});
