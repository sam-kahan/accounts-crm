import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plural } from '../src/lib/words.js';

test('plural says 1 email / 3 emails / 2 timeline entries', () => {
  assert.equal(plural(1, 'email'), '1 email');
  assert.equal(plural(0, 'email'), '0 emails');
  assert.equal(plural(2, 'timeline entry', 'timeline entries'), '2 timeline entries');
});

test('a drafted email always ends with the sign-off the sender’s name goes into', async () => {
  const { ensureSignOff, signEmail } = await import('../src/lib/signature.js');
  const ai = 'Dear team,\n\nPlease reply.\n\nKind regards,\n\nGreenco Property Group, Accounts\nGreenco';
  const fixed = ensureSignOff(ai);
  assert.equal(fixed, 'Dear team,\n\nPlease reply.\n\nKind regards,\n\n[Name]\n[Job title]\nGreenco');
  assert.equal(signEmail(fixed, { name: 'Sam Kahan', job_title: 'Accounts Manager' }).endsWith('Kind regards,\n\nSam Kahan\nAccounts Manager\nGreenco'), true);
  // Already has the placeholders: left alone.
  const ok = 'Hello\n\nKind regards,\n\n[Name]\n[Job title]\nGreenco';
  assert.equal(ensureSignOff(ok), ok);
  // No closing line at all: one is added.
  assert.match(ensureSignOff('Dear team,\n\nPlease reply.'), /Please reply\.\n\nKind regards,\n\n\[Name\]/);
});
