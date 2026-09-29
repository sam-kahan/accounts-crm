import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAnalysis, planFromAnalysis } from '../src/services/emailAnalysis.js';
import { matchEmailToComplaint } from '../src/services/emailIngest.js';

const TODAY = '2026-10-05';
const complaint = (over = {}) => ({
  state: 'open', stage: 'stage_1', raised_on: '2026-09-28', stage_started_on: '2026-09-28',
  acknowledged_on: null, responded_on: null, reference: null, ...over,
});
const analysis = (over = {}) => normaliseAnalysis({
  forwarded: true, author: 'LivingCity Customer Relations', from_organisation: true,
  sent_on: '2026-09-30', kind: 'acknowledgement', their_reference: 'CR-1234',
  summary: 'They acknowledge the complaint.', confidence: 'high', ...over,
}, { today: TODAY });

test('a clear-cut forwarded acknowledgement is recorded on the date THEY sent it', () => {
  const plan = planFromAnalysis(complaint(), analysis(), { today: TODAY });
  assert.equal(plan.auto, true);
  assert.deepEqual(plan.changes, { acknowledged_on: '2026-09-30', reference: 'CR-1234' });
  assert.deepEqual(plan.event, { type: 'acknowledged', date: '2026-09-30' });
  assert.equal(plan.reviewedAs, 'acknowledgement');
});

test('their reference never overwrites one already recorded', () => {
  const plan = planFromAnalysis(complaint({ reference: 'MINE' }), analysis(), { today: TODAY });
  assert.equal(plan.changes.reference, undefined);
});

test('anything the AI is not sure of waits for a person', () => {
  const plan = planFromAnalysis(complaint(), analysis({ confidence: 'medium' }), { today: TODAY });
  assert.equal(plan.auto, false);
  assert.match(plan.reason, /isn’t certain/);
});

test('no readable date → waits for a person (never the forward date)', () => {
  const plan = planFromAnalysis(complaint(), analysis({ sent_on: null }), { today: TODAY });
  assert.equal(plan.auto, false);
});

test('a date before the complaint was made does not fit', () => {
  const plan = planFromAnalysis(complaint(), analysis({ sent_on: '2026-09-01' }), { today: TODAY });
  assert.equal(plan.auto, false);
});

test('a Stage 1 response is recorded; a final response at Stage 1 is questioned', () => {
  const s1 = planFromAnalysis(complaint(), analysis({ kind: 'stage1_response', sent_on: '2026-10-02' }), { today: TODAY });
  assert.deepEqual(s1.changes, { responded_on: '2026-10-02', reference: 'CR-1234' });
  const fin = planFromAnalysis(complaint(), analysis({ kind: 'final_response' }), { today: TODAY });
  assert.equal(fin.auto, false);
});

test('a final response at Stage 2 starts the referral window', () => {
  const c = complaint({ stage: 'stage_2', stage_started_on: '2026-10-01', reference: 'X' });
  const plan = planFromAnalysis(c, analysis({ kind: 'final_response', sent_on: '2026-10-03' }), { today: TODAY });
  assert.deepEqual(plan.changes, { responded_on: '2026-10-03', final_response_on: '2026-10-03' });
});

test('a response when one is already recorded is not recorded twice (filed as correspondence)', () => {
  const plan = planFromAnalysis(complaint({ responded_on: '2026-10-01' }), analysis({ kind: 'stage1_response' }), { today: TODAY });
  assert.equal(plan.auto, true);
  assert.equal(plan.changes.responded_on, undefined);
  assert.equal(plan.reviewedAs, 'correspondence');
});

test('routine correspondence the AI is fairly sure of is filed by itself; anything that could change a date is not', () => {
  const routine = analysis({ kind: 'request_for_information', confidence: 'medium', summary: 'They ask for a copy of the tenancy agreement.' });
  assert.deepEqual(planFromAnalysis(complaint(), routine, { today: TODAY, text: 'Please send us a copy of the tenancy agreement.' }),
    { auto: true, changes: {}, reviewedAs: 'correspondence', event: null });
  // The words say it's an acknowledgement, whatever the AI called it: a person looks.
  assert.equal(planFromAnalysis(complaint(), { ...routine, kind: 'other' }, { today: TODAY, text: 'We acknowledge receipt of your complaint.' }).auto, false);
  // A medium-confidence acknowledgement still waits.
  assert.equal(planFromAnalysis(complaint(), analysis({ confidence: 'medium' }), { today: TODAY }).auto, false);
  // Low confidence always waits.
  assert.equal(planFromAnalysis(complaint(), { ...routine, confidence: 'low' }, { today: TODAY, text: 'x' }).auto, false);
  // A closed complaint takes nothing, so its emails are filed.
  assert.equal(planFromAnalysis(complaint({ stage: 'resolved', state: 'resolved' }), analysis(), { today: TODAY }).auto, true);
});

test('our own email (e.g. CC’d copy) is filed as correspondence, changing nothing', () => {
  const plan = planFromAnalysis(complaint(), analysis({ kind: 'our_email', from_organisation: true }), { today: TODAY });
  assert.equal(plan.auto, true);
  assert.deepEqual(plan.changes, {});
  assert.equal(plan.reviewedAs, 'correspondence');
});

test('a holding letter changes no dates but keeps their reference', () => {
  const plan = planFromAnalysis(complaint(), analysis({ kind: 'holding_or_extension' }), { today: TODAY });
  assert.equal(plan.auto, true);
  assert.deepEqual(plan.changes, { reference: 'CR-1234' });
  assert.equal(plan.event, null);
});

test('normaliseAnalysis drops impossible, future and malformed dates and unknown kinds', () => {
  assert.equal(analysis({ sent_on: '2026-02-30' }).sent_on, null);
  assert.equal(analysis({ sent_on: '2026-12-01' }).sent_on, null, 'future');
  assert.equal(analysis({ sent_on: '30/09/2026' }).sent_on, null);
  assert.equal(analysis({ kind: 'nonsense' }).kind, 'other');
  assert.equal(analysis({ confidence: 'certain' }).confidence, 'low');
});

test('normaliseAnalysis only accepts a complaint id from the candidates offered', () => {
  const a = normaliseAnalysis({ complaint_id: 'abc', kind: 'other' }, { candidateIds: ['xyz'] });
  assert.equal(a.complaint_id, null);
  const b = normaliseAnalysis({ complaint_id: 'xyz', kind: 'other' }, { candidateIds: ['xyz'] });
  assert.equal(b.complaint_id, 'xyz');
});

test('an email to the general inbox is kept for the AI to file', () => {
  const m = matchEmailToComplaint(
    { subject: 'FW: your complaint', toAddresses: ['complaint-inbox@greenco.co.uk'] },
    [{ id: 'c1', ref_code: 'GC-C-ABCDEF', email_address: 'complaint-abcdef@greenco.co.uk' }],
    'complaint-inbox@greenco.co.uk',
  );
  assert.deepEqual(m, { complaintId: null, method: 'inbox' });
});

test('an uncertain "not from them" is never filed away unseen (could be their acknowledgement)', () => {
  const plan = planFromAnalysis(complaint(), analysis({ from_organisation: false, confidence: 'low' }), { today: TODAY });
  assert.equal(plan.auto, false);
});

test('an uncertain "our own email" also waits for a person', () => {
  const plan = planFromAnalysis(complaint(), analysis({ kind: 'our_email', confidence: 'low' }), { today: TODAY });
  assert.equal(plan.auto, false);
});

import { resolutionSuggestion } from '../src/services/emailAnalysis.js';

test('an email saying it has been put right is flagged to confirm, never closed', () => {
  const r = resolutionSuggestion(analysis({ kind: 'stage1_response', resolved: true, outcome: 'Late fee removed and final bill issued' }));
  assert.equal(r.outcome, 'Late fee removed and final bill issued');
  assert.equal(r.on, '2026-09-30');
  assert.equal(resolutionSuggestion(analysis({ resolved: false })), null);
  assert.equal(resolutionSuggestion(analysis({ resolved: true, confidence: 'low' })), null);
  // someone who is neither them nor us (a tenant, say) can't resolve it
  assert.equal(resolutionSuggestion(analysis({ resolved: true, from_organisation: false, kind: 'other' })), null);
  // Greenco confirming it is sorted counts
  assert.equal(resolutionSuggestion(analysis({ resolved: true, from_organisation: false, kind: 'our_email' })).by_us, true);
});

import { planOurStep } from '../src/services/emailAnalysis.js';

const ours = (over = {}) => normaliseAnalysis({
  kind: 'our_email', from_organisation: false, sent_on: '2026-09-29', confidence: 'high',
  our_step: 'stage2_request', summary: 'Greenco asks for a Stage 2 review.', ...over,
}, { today: '2026-09-30' });

test('our Stage 2 request sent from Outlook moves the complaint to Stage 2 by itself, dated the day it went', () => {
  const plan = planFromAnalysis(complaint({ raised_on: '2026-08-27', stage_started_on: '2026-08-27' }), ours(), { today: '2026-09-30' });
  assert.equal(plan.auto, true);
  assert.deepEqual(plan.changes, { stage: 'stage_2', stage_started_on: '2026-09-29', responded_on: null, response_due_manual: false });
  assert.equal(plan.event.type, 'escalated');
});

test('not certain, already at Stage 2, or a chaser that only mentions Stage 2: nothing moves', () => {
  const c = complaint({ raised_on: '2026-08-27', stage_started_on: '2026-08-27' });
  assert.equal(planFromAnalysis(c, ours({ confidence: 'medium' }), { today: '2026-09-30' }).auto, false);
  assert.deepEqual(planFromAnalysis({ ...c, stage: 'stage_2' }, ours(), { today: '2026-09-30' }).changes, {});
  const chaser = normaliseAnalysis({ kind: 'our_email', sent_on: '2026-09-29', confidence: 'high', our_step: null }, { today: '2026-09-30' });
  assert.deepEqual(planFromAnalysis(c, chaser, { today: '2026-09-30' }).changes, {});
  // their email can't claim to be our step
  assert.equal(normaliseAnalysis({ kind: 'stage1_response', our_step: 'stage2_request' }).our_step, null);
});

test('our referral to the ombudsman: from Stage 2 only, keeping their Stage 2 answer as the final response', () => {
  const s2 = complaint({ stage: 'stage_2', raised_on: '2026-06-01', stage_started_on: '2026-07-01', responded_on: '2026-07-20' });
  const plan = planFromAnalysis(s2, ours({ our_step: 'ombudsman_referral' }), { today: '2026-09-30' });
  assert.equal(plan.changes.stage, 'ombudsman');
  assert.equal(plan.changes.final_response_on, '2026-07-20');
  assert.equal(planFromAnalysis(complaint(), ours({ our_step: 'ombudsman_referral' }), { today: '2026-09-30' }).auto, false);
});

test('planFromAnalysis: an unplaced acknowledgement or response on a two-organisation complaint waits for a person', () => {
  const main = { stage: 'stage_2', state: 'open', raised_on: '2026-07-01', stage_started_on: '2026-09-01', acknowledged_on: '2026-07-02' };
  const ack = { kind: 'acknowledgement', confidence: 'high', from_organisation: true, sent_on: '2026-09-10', summary: 'We acknowledge' };
  assert.equal(planFromAnalysis(main, ack, { today: '2026-09-29', soleTrack: false }).auto, false);
  const ended = { ...main, stage: 'resolved', state: 'resolved' };
  const resp = { kind: 'final_response', confidence: 'high', from_organisation: true, sent_on: '2026-09-10', summary: 'Our final response' };
  assert.equal(planFromAnalysis(ended, resp, { today: '2026-09-29', soleTrack: false }).auto, false);
  // Routine correspondence still files itself.
  const routine = { kind: 'other', confidence: 'high', from_organisation: true, sent_on: '2026-09-10', summary: 'Please send a meter reading' };
  assert.equal(planFromAnalysis(main, routine, { today: '2026-09-29', soleTrack: false }).auto, true);
});

test('not sent to them yet: their acknowledgement waits for a person, never dates the complaint', () => {
  const plan = planFromAnalysis(complaint({ not_sent_yet: true }), analysis(), { today: TODAY });
  assert.equal(plan.auto, false);
  assert.match(plan.reason, /hasn’t been sent to them yet/);
  // Once it has gone (the flag cleared), the same email is recorded as usual.
  assert.equal(planFromAnalysis(complaint({ not_sent_yet: false }), analysis(), { today: TODAY }).auto, true);
});

import { isOurOwnEmail } from '../src/services/emailAnalysis.js';

test('a colleague’s chaser is ours by its sender, filed without a person, whatever the AI made of it', () => {
  const chaser = { sender_email: 'Imogen.Moore@greenco.co.uk', subject: 'A44442483//A44442453' };
  // The AI unsure, or reading her "no response" wording as their response: still ours.
  // Unread, it waits (it could be our Stage 2 request; filing it would stop it ever being read).
  assert.equal(planFromAnalysis(complaint(), null, { today: TODAY, ownEmail: true }).auto, false);
  for (const a of [analysis({ forwarded: false, kind: 'response', from_organisation: false, confidence: 'medium' }),
    analysis({ forwarded: false, kind: 'correspondence', from_organisation: false, confidence: 'low' }),
    // Even read as theirs, if it isn't read as a forward: she wrote it.
    analysis({ forwarded: false, kind: 'acknowledgement', confidence: 'high' })]) {
    assert.equal(isOurOwnEmail(chaser, a, 'greenco.co.uk'), true);
    const plan = planFromAnalysis(complaint({ acknowledged_on: '2026-09-01' }), a, { today: TODAY, ownEmail: true });
    assert.equal(plan.auto, true);
    assert.deepEqual(plan.changes, {});
    assert.equal(plan.event, null);
    assert.equal(plan.reviewedAs, 'correspondence');
  }
});

test('a colleague forwarding THEIR email is not ours: it is read as theirs', () => {
  assert.equal(isOurOwnEmail({ sender_email: 'imogen.moore@greenco.co.uk', subject: 'FW: Your complaint CR-1' }, analysis(), 'greenco.co.uk'), false);
  assert.equal(isOurOwnEmail({ sender_email: 'imogen.moore@greenco.co.uk', subject: 'Your complaint' }, analysis({ forwarded: true, from_organisation: true }), 'greenco.co.uk'), false);
  assert.equal(isOurOwnEmail({ sender_email: 'complaints@council.gov.uk', subject: 'Re: x' }, null, 'greenco.co.uk'), false);
  assert.equal(isOurOwnEmail({ sender_email: 'someone@notgreenco.co.uk', subject: 'x' }, null, 'greenco.co.uk'), false);
});

test('our own Stage 2 request still moves the complaint on', () => {
  const a = analysis({ kind: 'our_email', from_organisation: false, our_step: 'stage2_request', sent_on: '2026-10-02' });
  const plan = planFromAnalysis(complaint({ acknowledged_on: '2026-09-29', responded_on: '2026-10-01' }), a, { today: TODAY, ownEmail: true });
  assert.equal(plan.changes?.stage, 'stage_2');
});
