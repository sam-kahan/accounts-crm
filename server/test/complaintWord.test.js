import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usesComplaintWord, holdToComplaintWord } from '../src/services/complaintRules.js';
import { normaliseReconstruction } from '../src/services/complaintReconstruct.js';

test('the word itself, in its forms', () => {
  for (const t of ['We wish to make a formal complaint', 'I am writing to complain', 'Please log this as a complaint',
    'Submitted through their complaints form', 'We complained on 3 June']) assert.equal(usesComplaintWord(t), true, t);
  // Imogen's email of 28 Sep: a refund request, never the word.
  for (const t of ['we request refund of the added summons fee as we are not at fault', 'Please refund us the summons cost of £61',
    'We are very unhappy with this', '']) assert.equal(usesComplaintWord(t), false, t);
});

test('a reading without the word in its quoted sentence is not a complaint, and has no dates', () => {
  const r = holdToComplaintWord({ is_complaint: true, subject: 'Summons costs', raised_on: '2026-09-28', acknowledged_on: '2026-09-29',
    stage: 'stage_2', complaint_evidence: { quote: 'please refund us the summons cost of £61', date: '2026-09-28' } });
  assert.equal(r.is_complaint, false);
  assert.equal(r.raised_on, null);
  assert.equal(r.acknowledged_on, null);
  assert.equal(r.stage, 'stage_1');
  assert.equal(r.subject, 'Summons costs'); // the rest of the form is kept
  assert.equal(holdToComplaintWord({ is_complaint: true, subject: 'x' }).is_complaint, false); // no quote at all
});

test('with the word, the complaint was made on the quoted sentence’s date', () => {
  const r = holdToComplaintWord({ is_complaint: true, raised_on: '2026-09-01',
    complaint_evidence: { quote: 'We now wish to raise a formal complaint about the summons costs.', date: '2026-10-01' } });
  assert.equal(r.is_complaint, true);
  assert.equal(r.raised_on, '2026-10-01');
});

test('an import is never made from a sentence without the word', () => {
  const x = normaliseReconstruction({ is_complaint: true, subject: 'Summons', complaint_evidence: { quote: 'Please refund the £61 summons fee', date: '2026-09-28' }, raised_on: '2026-09-28' }, { today: '2026-09-30' });
  assert.equal(x.is_complaint, false);
  assert.match(x.not_complaint_why, /word “complaint”/);
  const y = normaliseReconstruction({ is_complaint: true, subject: 'Summons', complaint_evidence: { quote: 'Please treat this as a formal complaint', date: '2026-09-28' } }, { today: '2026-09-30' });
  assert.equal(y.is_complaint, true);
  assert.equal(y.raised_on, '2026-09-28');
});
