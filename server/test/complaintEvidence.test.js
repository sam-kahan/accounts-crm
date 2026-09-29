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
  assert.match(item(main, 'response').detail, /none came by Wed 26 Aug 2026, the date it was due/);
  assert.equal(item(main, 'emails').state, 'missing');
});

test('what is on file is recognised, per organisation', () => {
  const c = { ...base, stage: 'stage_2', stage_started_on: '2026-09-01', responded_on: null, final_response_on: null, response_due: '2026-10-29',
    account_numbers: ['58669277'], outcome_wanted: 'Correct the bill and refund £120', losses: '£120 overcharged' };
  const lcs = { id: 'p1', org_name: 'LCS', raised_on: '2026-08-10', stage: 'stage_1', state: 'open', response_due: '2026-10-05' };
  const emails = [
    { id: 'e1', subject: 'Formal complaint', ours: true, on: '2026-07-02', keys: ['main'] },
    { id: 'e2', subject: 'Our response', ours: false, on: '2026-08-21', keys: ['main'] },
    { id: 'e3', subject: 'Stage 2 request', ours: true, on: '2026-09-01', keys: ['main'] },
    { id: 'e4', subject: 'Complaint', ours: true, on: '2026-08-10', keys: ['p1'] },
  ];
  const docs = [{ id: 'd1' }, { id: 'd2', source_email_id: 'e2' }];
  const events = [
    { type: 'note', note: 'Phoned British Gas, spoke to Amy', created_by: 'Sam' },
    { type: 'note', note: 'Phone words from an import', created_by: 'Import (read from the emails)' },
    { type: 'note', note: 'Unclear in the emails: a call on 3 Aug', created_by: 'Re-check (read from the emails)' },
    { type: 'response_received', party_id: null, event_date: '2026-08-20', note: 'Stage 1 response by email: Our response', created_by: 'Sam' },
    { type: 'escalated', party_id: null, event_date: '2026-09-01', note: 'Escalated to Stage 2', created_by: 'Sam' },
  ];
  const r = evidenceChecklist({ complaint: c, parties: [lcs], emails, docs, events, today });
  for (const k of ['account', 'documents', 'calls', 'outcome', 'losses']) assert.equal(item(r.shared, k).state, 'ok', k);
  assert.match(item(r.shared, 'documents').detail, /2 documents on file \(1 uploaded, 1 from emails\)/);
  assert.match(item(r.shared, 'calls').detail, /^1 call /);
  const [bg, lc] = r.tracks;
  assert.equal(item(bg.items, 'complaint').state, 'ok');
  assert.equal(item(bg.items, 'response1').state, 'ok');
  assert.equal(item(bg.items, 'response').state, 'na');
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

test('copies a colleague forwarded in count, placed by who wrote them', () => {
  const c = { ...base, responded_on: '2026-08-20' };
  // Forwarded: only our own address on them, so no keys from addresses.
  const emails = [
    { id: 'f1', subject: 'Fwd: Formal complaint', ours: true, on: '2026-07-01', keys: [] },
    { id: 'f2', subject: 'Fwd: Our response', ours: false, on: '2026-08-20', keys: [], author_org: 'British Gas', kind: 'stage1_response' },
  ];
  const r = evidenceChecklist({ complaint: c, emails, today });
  assert.equal(item(r.tracks[0].items, 'complaint').state, 'ok');
  assert.equal(item(r.tracks[0].items, 'response').state, 'ok');
  // With two organisations, a forward is placed by who wrote it, never guessed.
  const lcs = { id: 'p1', org_name: 'LCS', raised_on: '2026-08-10', stage: 'stage_1', state: 'open', response_due: '2026-10-05', responded_on: '2026-08-20' };
  const two = evidenceChecklist({ complaint: c, parties: [lcs], emails, today });
  assert.equal(item(two.tracks[0].items, 'response').state, 'ok');
  assert.equal(item(two.tracks[1].items, 'response').state, 'missing');
});

test('referred to the ombudsman: the Stage 2 request and the missing final response stay on the list', () => {
  const c = { ...base, stage: 'ombudsman', stage_started_on: '2026-09-20', responded_on: null, final_response_on: null, response_due: null };
  const events = [{ type: 'escalated', party_id: null, event_date: '2026-08-01', note: 'Escalated to Stage 2', created_by: 'Sam' },
    { type: 'escalated', party_id: null, event_date: '2026-09-20', note: 'Referred to the Energy Ombudsman', created_by: 'Sam' }];
  const emails = [{ id: 's2', subject: 'Stage 2 request', ours: true, on: '2026-08-01', keys: ['main'] }];
  const r = evidenceChecklist({ complaint: c, emails, events, today });
  const items = r.tracks[0].items;
  assert.equal(item(items, 'stage2').state, 'ok');
  assert.equal(item(items, 'response').state, 'ok');
  assert.match(item(items, 'response').detail, /none came before it was referred/);
  assert.equal(item(items, 'response1').state, 'na');
});
