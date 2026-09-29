import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingFirstEmail, deriveStatus, procedureSteps, effectiveRule } from '../src/services/complaintRules.js';

const notSent = { state: 'open', stage: 'stage_1', channel: 'email', not_sent_yet: true, org_name: 'Liverpool City Council', org_type: 'council', raised_on: '2026-09-29' };

test('only a complaint marked not sent yet awaits its first email', () => {
  assert.equal(awaitingFirstEmail(notSent), true);
  // Everything already on file (no flag) is left exactly as it was, emails or not.
  assert.equal(awaitingFirstEmail({ ...notSent, not_sent_yet: false }), false);
  assert.equal(awaitingFirstEmail({ ...notSent, not_sent_yet: undefined }), false);
});

test('anything from them, a later stage or a closed complaint means it has gone', () => {
  assert.equal(awaitingFirstEmail({ ...notSent, acknowledged_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...notSent, responded_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...notSent, final_response_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...notSent, stage: 'stage_2' }), false);
  assert.equal(awaitingFirstEmail({ ...notSent, state: 'resolved' }), false);
});

test('not sent yet: nothing due, nothing to chase, no dated steps', () => {
  const rule = effectiveRule(null, 'council');
  const s = deriveStatus(notSent, rule);
  assert.equal(s.status, 'not_sent');
  assert.equal(s.needs_chasing, false);
  assert.match(s.nextAction, /^Send the complaint to Liverpool City Council/);
  const steps = procedureSteps(notSent, rule);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, 'pending');
  assert.equal(steps[0].date, null);
  // The same complaint without the flag is dated as before.
  assert.notEqual(deriveStatus({ ...notSent, not_sent_yet: false }, rule).status, 'not_sent');
});
