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

test('a drafted email loses the stock phrases that give it away, and nothing else', async () => {
  const { tidyEmail } = await import('../src/lib/signature.js');
  const ai = 'Dear Complaints Team,\n\nI hope this email finds you well.\n\nWe complained on 1 September 2026 — you have not replied. Please confirm by 10 October.\n\nPlease do not hesitate to contact us if you need anything further.\n\nKind regards,';
  const out = tidyEmail(ai);
  assert.doesNotMatch(out, /hope this email finds you well/i);
  assert.doesNotMatch(out, /hesitate/i);
  assert.doesNotMatch(out, /—/);
  assert.match(out, /We complained on 1 September 2026, you have not replied\. Please confirm by 10 October\./);
  assert.match(out, /^Dear Complaints Team,\n\nWe complained/);
  // An ordinary email is left exactly as it is.
  const plain = 'Dear Sir or Madam,\n\nPlease confirm the balance.\n\nKind regards,';
  assert.equal(tidyEmail(plain), plain);
});
