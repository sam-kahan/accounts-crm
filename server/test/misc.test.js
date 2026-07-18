import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complaintEmailAddress } from '../src/config.js';
import { todayISO } from '../src/lib/dates.js';

test('complaintEmailAddress builds the per-complaint catch-all address', () => {
  // Uses the default prefix/domain (complaint-/greenco.co.uk) and the code
  // segment of the ref, lower-cased.
  assert.equal(complaintEmailAddress('GC-C-71923E'), 'complaint-71923e@greenco.co.uk');
});

test('complaintEmailAddress returns null without a ref code', () => {
  assert.equal(complaintEmailAddress(null), null);
  assert.equal(complaintEmailAddress(''), null);
});

test('todayISO returns a YYYY-MM-DD string', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});
