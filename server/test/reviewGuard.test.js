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
