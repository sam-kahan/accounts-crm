import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProfile } from '../src/services/companiesHouse.js';

const baseProfile = {
  company_name: 'Greenco Widgets Ltd',
  company_number: '01234567',
  company_status: 'active',
  date_of_creation: '2010-01-01',
  accounts: {
    next_due: '2026-12-31',
    next_made_up_to: '2026-03-31',
  },
  confirmation_statement: {
    next_made_up_to: '2026-06-15',
    next_due: '2026-06-29',
  },
};

test('confirmation statement key date reminds on the statement DATE, not the deadline', () => {
  const { keyDates } = mapProfile(baseProfile);
  const cs = keyDates.find((k) => k.category === 'confirmation_statement');
  assert.ok(cs, 'confirmation statement key date should be present');
  // The reminder date is the made-up-to date (fileable from), not next_due.
  assert.equal(cs.due_date, '2026-06-15');
  assert.notEqual(cs.due_date, baseProfile.confirmation_statement.next_due);
});

test('confirmation statement key date falls back to the deadline if no made-up-to', () => {
  const { keyDates } = mapProfile({
    ...baseProfile,
    confirmation_statement: { next_due: '2026-06-29' },
  });
  const cs = keyDates.find((k) => k.category === 'confirmation_statement');
  assert.ok(cs);
  assert.equal(cs.due_date, '2026-06-29');
});

test('company carries both confirmation statement dates', () => {
  const { company } = mapProfile(baseProfile);
  assert.equal(company.confirmation_statement_next_made_up_to, '2026-06-15');
  assert.equal(company.confirmation_statement_next_due, '2026-06-29');
});

test('accounts key dates: year end uses made-up-to, accounts due uses the deadline', () => {
  const { keyDates } = mapProfile(baseProfile);
  const yearEnd = keyDates.find((k) => k.category === 'year_end');
  const accounts = keyDates.find((k) => k.category === 'accounts');
  assert.equal(yearEnd.due_date, '2026-03-31');
  assert.equal(accounts.due_date, '2026-12-31');
});

test('no confirmation statement block yields no confirmation statement key date', () => {
  const { keyDates, company } = mapProfile({
    ...baseProfile,
    confirmation_statement: undefined,
  });
  assert.equal(
    keyDates.find((k) => k.category === 'confirmation_statement'),
    undefined,
  );
  assert.equal(company.confirmation_statement_next_made_up_to, null);
});
