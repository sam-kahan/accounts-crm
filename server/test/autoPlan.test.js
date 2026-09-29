import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPlan, AUTO_TRIES, monthsAgo } from '../src/services/pastComplaints.js';

const now = new Date('2026-09-28T12:00:00Z');
const row = (over = {}) => ({ extracted: { confidence: 'high' }, error: null, import_attempts: 0, last_attempt_at: null, accounts_read_at: now, ...over });

test('a new complaint the AI is sure of is imported now', () => {
  const p = autoPlan([row()], { now });
  assert.equal(p.will, 'import');
  assert.equal(p.due, true);
});

test('one the AI was less sure of waits for a person', () => {
  const p = autoPlan([row({ extracted: { confidence: 'medium' } })], { now });
  assert.equal(p.will, null);
  assert.equal(p.due, false);
});

test('certainly on file is linked; possibly on file waits', () => {
  assert.equal(autoPlan([row()], { hit: { ref_code: 'GC-C-X' }, certain: true, now }).will, 'link');
  const maybe = autoPlan([row()], { hit: { ref_code: 'GC-C-X' }, certain: false, now });
  assert.equal(maybe.will, null);
});

test('a failure waits half an hour, then is tried again, up to the limit', () => {
  const recent = row({ error: 'boom', import_attempts: 1, last_attempt_at: new Date(now - 10 * 60000) });
  const p1 = autoPlan([recent], { now });
  assert.equal(p1.will, 'import');
  assert.equal(p1.due, false);
  const older = row({ error: 'boom', import_attempts: 1, last_attempt_at: new Date(now - 40 * 60000) });
  assert.equal(autoPlan([older], { now }).due, true);
  // failed before tries were recorded: no date, so due now (not never)
  assert.equal(autoPlan([row({ error: 'old failure' })], { now }).due, true);
  const spent = row({ error: 'boom', import_attempts: AUTO_TRIES, last_attempt_at: new Date(now - 60 * 60000) });
  assert.equal(autoPlan([spent], { now }).will, null);
  // a new thread joining a spent group doesn't reset it
  assert.equal(autoPlan([spent, row()], { now }).will, null);
});

test('paused, a related import running, or not set up: not due, and says why', () => {
  assert.equal(autoPlan([row()], { paused: true, now }).due, false);
  assert.match(autoPlan([row()], { paused: true, now }).note, /update is installed/);
  assert.equal(autoPlan([row()], { relatedRunning: true, now }).due, false);
  const off = autoPlan([row()], { enabled: false, now });
  assert.equal(off.will, null);
  assert.match(off.note, /set up/);
});

test('nothing is imported or linked until its account number has been read', () => {
  const unread = row({ accounts_read_at: null });
  const p = autoPlan([unread], { now });
  assert.equal(p.due, false);
  assert.match(p.note, /account number/);
  // read by the full read at search time (the field is there, even if empty)
  assert.equal(autoPlan([row({ accounts_read_at: null, extracted: { confidence: 'high', account_numbers: [] } })], { now }).due, true);
});

test('a thread about a complaint a person skipped waits for a person', () => {
  const p = autoPlan([row()], { skipped: true, now });
  assert.equal(p.will, null);
  assert.equal(p.due, false);
  assert.match(p.note, /skipped/);
  // Certainly already on file: still linked (nothing new is made).
  assert.equal(autoPlan([row()], { skipped: true, hit: { ref_code: 'GC-C-X' }, certain: true, now }).will, 'link');
});

test('months back are clamped to the month end, never overflowing', () => {
  assert.equal(monthsAgo(3, new Date('2026-05-31T10:00:00Z')).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(monthsAgo(12, new Date('2028-02-29T10:00:00Z')).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(monthsAgo(1, new Date('2026-09-29T10:00:00Z')).toISOString().slice(0, 10), '2026-08-29');
});
