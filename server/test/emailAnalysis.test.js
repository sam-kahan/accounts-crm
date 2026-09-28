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

test('a response when one is already recorded is not recorded twice', () => {
  const plan = planFromAnalysis(complaint({ responded_on: '2026-10-01' }), analysis({ kind: 'stage1_response' }), { today: TODAY });
  assert.equal(plan.auto, false);
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
