import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateSet } from '../src/lib/sql.js';

test('skips undefined (omitted) fields', () => {
  const { clause, values } = buildUpdateSet({ a: 1, b: undefined, c: 'x' });
  assert.equal(clause, 'a = $2, c = $3');
  assert.deepEqual(values, [1, 'x']);
});

test('keeps explicit null so a nullable column can be cleared', () => {
  const { clause, values } = buildUpdateSet({ note: null, title: 'keep' });
  assert.equal(clause, 'note = $2, title = $3');
  assert.deepEqual(values, [null, 'keep']);
});

test('numbers params after the reserved WHERE id ($1)', () => {
  const { clause } = buildUpdateSet({ x: 1, y: 2 });
  assert.equal(clause, 'x = $2, y = $3');
});

test('honours a custom afterParam offset', () => {
  const { clause, values } = buildUpdateSet({ x: 'v' }, 3);
  assert.equal(clause, 'x = $4');
  assert.deepEqual(values, ['v']);
});

test('all-omitted yields an empty clause (caller should 400)', () => {
  const { clause, values } = buildUpdateSet({ a: undefined, b: undefined });
  assert.equal(clause, '');
  assert.deepEqual(values, []);
});
