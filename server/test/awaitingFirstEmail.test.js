import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingFirstEmail } from '../src/services/complaintRules.js';

const fresh = { state: 'open', stage: 'stage_1', channel: 'email', complaint_doubt: null };

test('a complaint logged with nothing sent or received awaits its first email', () => {
  assert.equal(awaitingFirstEmail(fresh), true);
});

test('any email on it, or one queued, means it is under way', () => {
  assert.equal(awaitingFirstEmail(fresh, { emailCount: 1 }), false);
  assert.equal(awaitingFirstEmail(fresh, { outboxCount: 1 }), false);
});

test('made formally from the page once: never offered again', () => {
  assert.equal(awaitingFirstEmail(fresh, { formallyMade: true }), false);
});

test('anything from them, a later stage, a phone complaint or a second organisation: not offered', () => {
  assert.equal(awaitingFirstEmail({ ...fresh, acknowledged_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...fresh, responded_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...fresh, final_response_on: '2026-09-30' }), false);
  assert.equal(awaitingFirstEmail({ ...fresh, stage: 'stage_2' }), false);
  assert.equal(awaitingFirstEmail({ ...fresh, channel: 'phone' }), false);
  assert.equal(awaitingFirstEmail(fresh, { hasParties: true }), false);
});

test('closed, or already questioned by a re-check (its own button): not offered', () => {
  assert.equal(awaitingFirstEmail({ ...fresh, state: 'resolved' }), false);
  assert.equal(awaitingFirstEmail({ ...fresh, complaint_doubt: { kind: 'not_complaint' } }), false);
});
