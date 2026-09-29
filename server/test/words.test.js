import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plural } from '../src/lib/words.js';

test('plural says 1 email / 3 emails / 2 timeline entries', () => {
  assert.equal(plural(1, 'email'), '1 email');
  assert.equal(plural(0, 'email'), '0 emails');
  assert.equal(plural(2, 'timeline entry', 'timeline entries'), '2 timeline entries');
});
