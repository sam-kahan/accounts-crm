import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceChecklist } from '../src/services/complaintEvidence.js';

const today = '2026-09-29';
const base = {
  org_name: 'British Gas', raised_on: '2026-07-01', stage: 'stage_1', stage_started_on: '2026-07-01', state: 'open',
  response_due: '2026-08-26', account_numbers: [], channel: 'email',
};
const item = (list, key) => list.find((i) => i.key === key);

test('an empty complaint says what to collect, and how', () => {
  const r = evidenceChecklist({ complaint: base, forwardTo: 'complaint-abc@greenco.co.uk', today });
  assert.equal(item(r.shared, 'account').state, 'missing');
  assert.equal(item(r.shared, 'documents').state, 'missing');
  assert.equal(item(r.shared, 'outcome').state, 'missing');
  assert.equal(item(r.shared, 'losses').state, 'optional');
  const main = r.tracks[0].items;
  assert.equal(item(main, 'complaint').state, 'missing');
  assert.match(item(main, 'complaint').fix, /complaint-abc@greenco\.co\.uk/);
  assert.match(item(main, 'complaint').fix, /Wed 1 Jul 2026/);
  // Their response never came and the date has passed: that IS the evidence.
  assert.equal(item(main, 'response').state, 'ok');
  assert.match(item(main, 'response').detail, /missed the date, Wed 26 Aug 2026/);
  assert.equal(item(main, 'emails').state, 'missing');
});

test('what is on file is recognised, per organisation', () => {
  const c = { ...base, stage: 'stage_2', stage_started_on: '2026-09-01', responded_on: '2026-08-20', final_response_on: null,
    account_numbers: ['58669277'], outcome_wanted: 'Correct the bill and refund £120', losses: '£120 overcharged' };
  const lcs = { id: 'p1', org_name: 'LCS', raised_on: '2026-08-10', stage: 'stage_1', state: 'open', response_due: '2026-10-05' };
  const emails = [
    { id: 'e1', subject: 'Formal complaint', ours: true, on: '2026-07-02', keys: ['main'] },
    { id: 'e2', subject: 'Our response', ours: false, on: '2026-08-21', keys: ['main'] },
    { id: 'e3', subject: 'Stage 2 request', ours: true, on: '2026-09-01', keys: ['main'] },
    { id: 'e4', subject: 'Complaint', ours: true, on: '2026-08-10', keys: ['p1'] },
  ];
  const docs = [{ id: 'd1' }, { id: 'd2', source_email_id: 'e2' }];
  const events = [{ note: 'Phoned British Gas, spoke to Amy', created_by: 'Sam' }, { note: 'Phone words from an import', created_by: 'Import (read from the emails)' }];
  const r = evidenceChecklist({ complaint: c, parties: [lcs], emails, docs, events, today });
  for (const k of ['account', 'documents', 'calls', 'outcome', 'losses']) assert.equal(item(r.shared, k).state, 'ok', k);
  assert.match(item(r.shared, 'documents').detail, /2 documents on file \(1 uploaded, 1 from emails\)/);
  assert.match(item(r.shared, 'calls').detail, /^1 call /);
  const [bg, lc] = r.tracks;
  assert.equal(item(bg.items, 'complaint').state, 'ok');
  assert.equal(item(bg.items, 'response').state, 'ok');
  assert.equal(item(bg.items, 'response').label, 'Their final response');
  assert.equal(item(bg.items, 'stage2').state, 'ok');
  assert.match(item(bg.items, 'emails').detail, /3 emails: 1 from them, 2 from us/);
  // LCS: its own complaint email counts for it, not British Gas's.
  assert.equal(lc.org_name, 'LCS');
  assert.equal(item(lc.items, 'complaint').state, 'ok');
  assert.equal(item(lc.items, 'response').state, 'na');
  assert.equal(item(lc.items, 'stage2'), undefined);
  assert.equal(r.missing, 0);
});

test('a recorded response with no copy on file is asked for', () => {
  const r = evidenceChecklist({ complaint: { ...base, responded_on: '2026-08-20' }, today });
  assert.equal(item(r.tracks[0].items, 'response').state, 'missing');
  assert.match(item(r.tracks[0].items, 'response').fix, /Thu 20 Aug 2026 isn't on file/);
});

test('a complaint made by phone asks for the call to be noted, not a copy', () => {
  const r = evidenceChecklist({ complaint: { ...base, channel: 'phone' }, today });
  assert.equal(item(r.tracks[0].items, 'complaint').state, 'optional');
});
