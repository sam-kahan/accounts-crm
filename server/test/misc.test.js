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

import { buildDigest } from '../src/services/mailer.js';

test('digest escapes item text and shows the next step with a link', () => {
  const d = buildDigest([{
    due_date: '2026-10-01', label: 'Complaint <script>x</script>', company_name: 'A & B',
    detail: 'Chase them', link: 'https://accounts.greenco.co.uk/complaints/1', overdue: true,
  }]);
  assert.ok(!d.html.includes('<script>'));
  assert.ok(d.html.includes('&lt;script&gt;'));
  assert.ok(d.html.includes('href="https://accounts.greenco.co.uk/complaints/1"'));
  assert.ok(d.text.includes('Next: Chase them'));
});

test('digest never links a non-http address', () => {
  const d = buildDigest([{ due_date: '2026-10-01', label: 'x', link: 'javascript:alert(1)' }]);
  assert.ok(!d.html.includes('javascript:'));
});

import { withExternalCc } from '../src/services/mailer.js';

test('every email sent to someone outside copies in utilities@ (once)', () => {
  assert.deepEqual(withExternalCc(['complaints@britishgas.co.uk'], ['complaint-abc234@greenco.co.uk']),
    ['complaint-abc234@greenco.co.uk', 'utilities@greenco.co.uk']);
  // already a recipient: not added twice
  assert.deepEqual(withExternalCc(['Utilities@greenco.co.uk'], []), []);
});

import { isDigitSlip, dropDigitSlips, cleanAccountNumbers, slipNote } from '../src/services/accountNumbers.js';

test('an account number with a digit missing is the same account mistyped, and is dropped', () => {
  assert.equal(isDigitSlip('A4237652', 'A42737652'), true);
  assert.equal(isDigitSlip('A4237652', 'A42737611'), false);
  assert.equal(isDigitSlip('A42737652', 'A4237652'), false); // the full one is never the slip
  assert.equal(isDigitSlip('8500 1234 567', '8500-1234-5678'), true); // separators don't matter
  assert.equal(isDigitSlip('12345', '123456'), false); // too short to be sure
  const { kept, removed } = dropDigitSlips(['A4237652', 'A42737611', 'A42737652']);
  assert.deepEqual(kept, ['A42737611', 'A42737652']);
  assert.deepEqual(removed, [{ value: 'A4237652', of: 'A42737652' }]);
  assert.equal(slipNote(removed), 'Account number A4237652 removed: it is A42737652 with a digit missing.');
  assert.deepEqual(cleanAccountNumbers(['A42737652', 'A4237652']), ['A42737652']);
  // Two genuinely different accounts are both kept.
  assert.deepEqual(dropDigitSlips(['A42737611', 'A42737652']).kept, ['A42737611', 'A42737652']);
});

import { nextOccurrence } from '../src/lib/dates.js';

test('a recurring date rolls to the right day, never drifting past a month end', () => {
  assert.equal(nextOccurrence('2026-08-31', 'monthly', '2026-09-01'), '2026-09-30');
  assert.equal(nextOccurrence('2026-08-31', 'monthly', '2026-09-30'), '2026-10-31'); // back to the 31st
  assert.equal(nextOccurrence('2026-08-31', 'quarterly', '2026-09-01'), '2026-11-30');
  assert.equal(nextOccurrence('2024-02-29', 'annual', '2024-03-01'), '2025-02-28');
  assert.equal(nextOccurrence('2024-02-29', 'annual', '2027-03-01'), '2028-02-29');
  // Several periods overdue: lands after today, not on another past date.
  assert.equal(nextOccurrence('2026-01-15', 'monthly', '2026-09-29'), '2026-10-15');
  assert.equal(nextOccurrence('2026-09-29', 'monthly', '2026-09-29'), '2026-10-29');
  assert.equal(nextOccurrence('2026-01-15', 'none', '2026-09-29'), null);
});
