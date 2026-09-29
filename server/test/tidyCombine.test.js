import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineTracks } from '../src/services/tidy.js';

test('combining the same organisation twice keeps the earlier date and never loses progress', () => {
  // British Gas added "today" to a collector's complaint, while its own complaint from June was open.
  const june = { raised_on: '2026-06-22', stage: 'stage_1', state: 'open', stage_started_on: '2026-06-22', reference: 'A34025850' };
  const today = { raised_on: '2026-09-29', stage: 'stage_1', state: 'open', stage_started_on: '2026-09-29' };
  let r = combineTracks(june, today);
  assert.equal(r.fill.raised_on, '2026-06-22');
  assert.equal(r.fill.stage_started_on, '2026-06-22');
  assert.equal(r.fill.reference, 'A34025850');
  assert.equal(r.fill.response_due_manual, false);

  // The reviewer's case: an earlier Stage 1 record with no dates folded into a later one at Stage 2
  // with its acknowledgement and final response: nothing is wiped, the stage doesn't go back.
  const early = { raised_on: '2026-06-01', stage: 'stage_1', state: 'open' };
  const later = { raised_on: '2026-07-01', stage: 'stage_2', state: 'open', stage_started_on: '2026-08-01', acknowledged_on: '2026-07-03', final_response_on: null, responded_on: '2026-08-20' };
  r = combineTracks(early, later);
  assert.equal(r.fill.raised_on, '2026-06-01');
  assert.equal(r.fill.stage, undefined, 'the stage never moves back');
  assert.equal('acknowledged_on' in r.fill, false, 'a recorded date is kept');
  assert.equal('responded_on' in r.fill, false);

  // The other way round: the later page's complaint is at Stage 1, the earlier one reached Stage 2
  // with a final response. Combining onto the later one takes the further stage and its dates.
  const stage2 = { raised_on: '2026-05-01', stage: 'stage_2', state: 'open', stage_started_on: '2026-06-15', responded_on: null, final_response_on: '2026-06-10', acknowledged_on: '2026-05-03' };
  const stage1 = { raised_on: '2026-08-01', stage: 'stage_1', state: 'open', responded_on: '2026-08-10' };
  r = combineTracks(stage2, stage1);
  assert.equal(r.fill.stage, 'stage_2');
  assert.equal(r.fill.stage_started_on, '2026-06-15');
  assert.equal(r.fill.responded_on, null, 'a Stage 1 answer is not the Stage 2 answer');
  assert.equal(r.fill.final_response_on, '2026-06-10');
  assert.equal(r.fill.acknowledged_on, '2026-05-03');

  // Two different dates for the same thing: the one from the record whose stage is kept, the other noted.
  r = combineTracks({ raised_on: '2026-06-01', stage: 'stage_1', state: 'open', acknowledged_on: '2026-06-03' },
    { raised_on: '2026-06-02', stage: 'stage_1', state: 'open', acknowledged_on: '2026-06-05' });
  assert.equal('acknowledged_on' in r.fill, false);
  assert.match(r.notes.join(' '), /acknowledged Fri 5 Jun 2026 kept \(the other record says Wed 3 Jun 2026\)/);

  // A finished record never pulls an open one's stage along.
  r = combineTracks({ raised_on: '2026-01-01', stage: 'resolved', state: 'resolved' }, { raised_on: '2026-02-01', stage: 'stage_1', state: 'open' });
  assert.equal(r.fill.stage, undefined);
});
