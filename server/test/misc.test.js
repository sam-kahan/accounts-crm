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
