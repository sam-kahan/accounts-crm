import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecheck } from '../src/services/complaintRecheck.js';

const TODAY = '2026-09-28';
const c = (o = {}) => ({
  state: 'open', stage: 'stage_1', raised_on: '2026-03-02', stage_started_on: '2026-03-02',
  acknowledged_on: null, responded_on: null, final_response_on: null, reference: null, ...o,
});
const x = (o = {}) => ({
  is_complaint: true, confidence: 'high', stage: 'stage_1', state: 'open', raised_on: '2026-03-02',
  stage_started_on: null, acknowledged_on: null, responded_on: null, final_response_on: null,
  resolved_on: null, outcome: null, reference: null, uncertain: [], ...o,
});
const plan = (a, b, opt = {}) => planRecheck(a, b, { today: TODAY, ...opt });

test('an import left at Stage 1 moves to Stage 2 from the date it was asked for', () => {
  const p = plan(c({ responded_on: '2026-03-20' }), x({ stage: 'stage_2', stage_started_on: '2026-04-01', acknowledged_on: '2026-03-04' }));
  assert.equal(p.changes.stage, 'stage_2');
  assert.equal(p.changes.stage_started_on, '2026-04-01');
  assert.equal(p.changes.responded_on, null); // that was Stage 1's answer
  assert.equal(p.changes.response_due_manual, false);
  assert.equal(p.changes.acknowledged_on, '2026-03-04');
});

test('moved on with no date: no due date is invented', () => {
  const p = plan(c(), x({ stage: 'ombudsman' }));
  assert.equal(p.changes.stage, 'ombudsman');
  assert.equal(p.changes.response_due_manual, true);
  assert.equal(p.changes.response_due, null);
  assert.match(p.notes[0], /isn’t in the emails/);
});

test('a stage never moves backwards; it is reported instead', () => {
  const p = plan(c({ stage: 'stage_2' }), x({ stage: 'stage_1' }));
  assert.equal(p.changes.stage, undefined);
  assert.match(p.differs.join(), /recorded at Stage 2/);
});

test('a recorded date that differs is reported, never overwritten; a blank one is filled', () => {
  const p = plan(c({ acknowledged_on: '2026-03-05' }), x({ acknowledged_on: '2026-03-06', responded_on: '2026-03-18' }));
  assert.equal(p.changes.acknowledged_on, undefined);
  assert.equal(p.changes.responded_on, '2026-03-18');
  assert.match(p.differs.join(), /acknowledged is recorded as/);
});

test('a date before the complaint was made, or in the future, is not used', () => {
  const p = plan(c(), x({ acknowledged_on: '2026-02-01', responded_on: '2026-10-30' }));
  assert.deepEqual(p.changes, {});
  assert.match(p.differs.join(), /before the complaint was made/);
});

test('low confidence and more than one organisation change nothing', () => {
  assert.deepEqual(plan(c(), x({ confidence: 'low', stage: 'stage_2', stage_started_on: '2026-04-01' })).changes, {});
  const p = plan(c(), x({ stage: 'stage_2', stage_started_on: '2026-04-01' }), { hasParties: true });
  assert.deepEqual(p.changes, {});
  assert.match(p.differs.join(), /more than one organisation/);
});

test('resolved: applied only when clear, otherwise suggested', () => {
  const sure = plan(c(), x({ state: 'resolved', resolved_on: '2026-05-01', outcome: 'Refund of £120' }));
  assert.equal(sure.changes.stage, 'resolved');
  assert.equal(sure.changes.closed_on, '2026-05-01');
  const unsure = plan(c(), x({ state: 'resolved', resolved_on: '2026-05-01', confidence: 'medium' }));
  assert.equal(unsure.changes.stage, undefined);
  assert.match(unsure.differs.join(), /mark it resolved/);
});

test('a finished complaint, or a reading that isn’t a complaint, is left alone', () => {
  assert.ok(plan(c({ state: 'resolved', stage: 'resolved' }), x({ stage: 'stage_2' })).skip);
  assert.ok(plan(c(), x({ is_complaint: false })).skip);
});

test('leaving Stage 2 keeps their Stage 2 answer as the final response', () => {
  const p = plan(c({ stage: 'stage_2', responded_on: '2026-05-01', final_response_on: null }), x({ stage: 'ombudsman', stage_started_on: '2026-06-01' }));
  assert.equal(p.changes.stage, 'ombudsman');
  assert.equal(p.changes.final_response_on, '2026-05-01');
});

test('planRecheck: a complaint made formally from the page is never questioned, and still moves on', () => {
  const c = { stage: 'stage_1', state: 'open', raised_on: '2026-09-01', stage_started_on: '2026-09-01' };
  const x = { is_complaint: false, raised_on: '2026-04-17', confidence: 'high', stage: 'stage_1', state: 'open', acknowledged_on: '2026-09-03' };
  const plain = planRecheck(c, x, { today: '2026-09-29' });
  assert.equal(plain.doubt.kind, 'not_complaint');
  const formal = planRecheck(c, x, { today: '2026-09-29', formallyMade: true });
  assert.equal(formal.doubt, null);
  assert.equal(formal.skip, null);
  assert.equal(formal.differs.length, 0);
  assert.equal(formal.changes.acknowledged_on, '2026-09-03');
});

test('a response dated before the new stage began is never taken as its answer', () => {
  const p = plan(c(), x({ stage: 'stage_2', stage_started_on: '2026-08-01', responded_on: '2026-07-15' }));
  assert.equal(p.changes.stage, 'stage_2');
  assert.equal(p.changes.responded_on, null);
  assert.ok(p.differs.some((d) => /before Stage 2 began/.test(d)));
  // Already at Stage 2: an earlier date doesn't fill the blank.
  const q = plan(c({ stage: 'stage_2', stage_started_on: '2026-08-01' }), x({ stage: 'stage_2', stage_started_on: '2026-08-01', responded_on: '2026-07-15' }));
  assert.equal(q.changes.responded_on, undefined);
});

test('recheckUndoneWords says what an Undo put back in words, with UK dates', async () => {
  const { recheckUndoneWords } = await import('../src/services/complaintRecheck.js');
  assert.deepEqual(
    recheckUndoneWords({ stage: 'stage_1', stage_started_on: '2026-09-01', responded_on: null, response_due_manual: false, state: 'open' }),
    ['back to Stage 1', 'stage start date back to Tue 1 Sep 2026', 'date responded back to blank', 'open again'],
  );
  assert.deepEqual(recheckUndoneWords({}), []);
});
