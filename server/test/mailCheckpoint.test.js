import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCheckpoint, lookFrom, OVERLAP_MS } from '../src/services/mailCheckpoint.js';

const started = new Date('2026-09-29T12:00:00Z');

test('a look read to the end moves on to when it started', () => {
  assert.equal(nextCheckpoint({ started, complete: true }), '2026-09-29T12:00:00.000Z');
});

test('a look cut short carries on from the last email read', () => {
  const next = nextCheckpoint({ started, complete: false, readTo: new Date('2026-09-20T08:00:00Z') });
  // The next look steps back an hour, so it starts at that email.
  assert.equal(lookFrom(next).toISOString(), '2026-09-20T08:00:00.000Z');
});

test('an email that could not be stored is where the next look starts', () => {
  const next = nextCheckpoint({ started, complete: true, readTo: started, stoppedAt: new Date('2026-09-29T09:00:00Z') });
  const from = lookFrom(next);
  assert.ok(from <= new Date('2026-09-29T09:00:00Z'));
  assert.ok(from > new Date('2026-09-29T08:59:00Z'));
});

test('nothing read and not complete: the checkpoint stays', () => {
  assert.equal(nextCheckpoint({ started, complete: false, readTo: null }), null);
});

test('the first look goes back its window', () => {
  const from = lookFrom(null, 86400000);
  assert.ok(Math.abs(Date.now() - 86400000 - from.getTime()) < 5000);
  assert.equal(OVERLAP_MS, 3600000);
});
