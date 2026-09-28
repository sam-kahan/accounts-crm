import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReconstruction, storyText } from '../src/services/complaintReconstruct.js';

const TODAY = '2026-10-01';

test('a full reading is kept with real, ordered dates and a rebuilt timeline', () => {
  const r = normaliseReconstruction({
    org_name: 'E.ON Next', org_type: 'energy', org_complaints_email: 'Complaints@EONnext.com',
    subject: 'Final bill not issued', raised_on: '2026-07-10', stage: 'stage_2', stage_started_on: '2026-08-20',
    acknowledged_on: '2026-07-12', responded_on: null, final_response_on: null, state: 'open',
    events: [
      { date: '2026-08-20', type: 'escalated', note: 'Greenco asked for Stage 2.' },
      { date: '2026-07-12', type: 'acknowledged', note: 'E.ON acknowledged.' },
      { date: '2026-07-30', type: 'bogus', note: 'Chased by phone.' },
      { date: 'not a date', type: 'note', note: 'dropped' },
    ],
    confidence: 'high',
  }, { today: TODAY });
  assert.equal(r.org_complaints_email, 'complaints@eonnext.com');
  assert.equal(r.stage, 'stage_2');
  assert.equal(r.stage_started_on, '2026-08-20');
  assert.deepEqual(r.events.map((e) => e.date), ['2026-07-12', '2026-07-30', '2026-08-20'], 'sorted, bad date dropped');
  assert.equal(r.events[1].type, 'note', 'unknown type becomes a note');
});

test('impossible or future dates are dropped and flagged, never stored', () => {
  const r = normaliseReconstruction({
    raised_on: '2026-07-10', acknowledged_on: '2026-07-01', responded_on: '2026-12-01',
    state: 'open', resolved_on: '2026-08-01',
  }, { today: TODAY });
  assert.equal(r.acknowledged_on, null, 'before the complaint was made');
  assert.ok(r.uncertain.some((u) => u.includes('acknowledged on')));
  assert.equal(r.responded_on, null, 'in the future');
  assert.equal(r.resolved_on, null, 'not resolved, so no resolved date');
});

test('at Stage 1 the stage starts on the day it was raised', () => {
  const r = normaliseReconstruction({ raised_on: '2026-07-10', stage: 'stage_1', stage_started_on: '2026-09-01' }, { today: TODAY });
  assert.equal(r.stage_started_on, '2026-07-10');
});

test('the story is in date order, each email once', () => {
  const t = storyText([
    { messageId: 'b', receivedAt: '2026-07-12T10:00:00Z', senderEmail: 'x@eon.com', subject: 'RE', bodyText: 'second' },
    { messageId: 'a', receivedAt: '2026-07-10T10:00:00Z', senderEmail: 's@greenco.co.uk', subject: 'Complaint', bodyText: 'first' },
    { messageId: 'a', receivedAt: '2026-07-10T10:00:00Z', senderEmail: 's@greenco.co.uk', subject: 'Complaint', bodyText: 'first' },
  ]);
  assert.ok(t.indexOf('first') < t.indexOf('second'));
  assert.equal(t.split('first').length - 1, 1, 'the duplicate copy appears once');
});
