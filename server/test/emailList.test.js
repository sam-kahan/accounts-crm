import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmailList, emailListProblem, splitEmails } from '../src/lib/emailList.js';

test('several addresses are stored comma-separated, whatever separated them', () => {
  assert.equal(parseEmailList('accounts@jrb.co.uk,ben@jrb.co.uk').value, 'accounts@jrb.co.uk, ben@jrb.co.uk');
  assert.equal(parseEmailList(' accounts@jrb.co.uk ; ben@jrb.co.uk\n').value, 'accounts@jrb.co.uk, ben@jrb.co.uk');
  assert.equal(parseEmailList('a@x.co.uk b@x.co.uk').value, 'a@x.co.uk, b@x.co.uk');
});

test('one address is unchanged; blank clears', () => {
  assert.equal(parseEmailList('accounts@jrb.co.uk').value, 'accounts@jrb.co.uk');
  assert.equal(parseEmailList('').value, null);
  assert.equal(parseEmailList(' , ').value, null);
  assert.equal(emailListProblem(''), null);
});

test('the same address twice is kept once', () => {
  assert.deepEqual(splitEmails('Ben@jrb.co.uk, ben@JRB.co.uk'), ['Ben@jrb.co.uk']);
});

test('anything that is not an address is refused and named', () => {
  const p = emailListProblem('accounts@jrb.co.uk, ben@jrb');
  assert.match(p, /“ben@jrb” isn’t an email address/);
  assert.equal(emailListProblem('accounts@jrb.co.uk, ben@jrb.co.uk'), null);
});

test('a list longer than Greenco Invoicing keeps is refused', () => {
  const many = Array.from({ length: 40 }, (_, i) => `person${i}@a-long-domain-name.co.uk`).join(', ');
  assert.match(emailListProblem(many), /too many addresses/);
});
