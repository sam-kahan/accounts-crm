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
  assert.match(g.headline, /^Nothing to send yet/);
  assert.match(g.headline, /Thu 1 Oct 2026|Mon 5 Oct 2026/);
  assert.ok(g.email.body); // kept for if they miss it
});

test('58 Lawefield: we wrote to them today — no chaser, even though a date has passed', () => {
  const g = guardReview({ ...chase, headline: 'Send E.ON Next a written follow-up now.' }, {
    anyOverdue: true, nextDue: null, lastSentOn: '2026-09-28', today: TODAY,
  });
  assert.equal(g.next_action.type, 'wait');
  assert.match(g.headline, /you last wrote to them on Mon 28 Sep 2026\. Wait for their reply until Mon 5 Oct 2026/);
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
