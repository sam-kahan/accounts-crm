import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailsRequested, sentDay, copyText } from '../src/services/emailCopies.js';
import { textPdf, wrapText, LINE_CHARS } from '../src/lib/pdf.js';

const DOMAIN = 'greenco.co.uk';
const ours16 = { id: 'a', direction: 'outbound', sender_email: 'sam@greenco.co.uk', subject: 'Stage 2', body_text: 'Dear E.ON', received_at: '2026-09-16T09:00:00Z' };
const theirs16 = { id: 'b', direction: 'inbound', sender_email: 'x@eonnext.com', subject: 'Re: Stage 2', body_text: 'Thanks', received_at: '2026-09-16T15:00:00Z' };
const ours20 = { id: 'c', direction: 'outbound', sender_email: 'sam@greenco.co.uk', subject: 'Chase', body_text: 'Chasing', received_at: '2026-09-20T09:00:00Z' };
const all = [ours16, theirs16, ours20];
const opts = { today: '2026-10-06', ourDomain: DOMAIN };

test('a copy of our email of a date is that email', () => {
  assert.deepEqual(emailsRequested({ item: 'Copy of our 16 September 2026 email' }, all, opts).map((e) => e.id), ['a']);
  assert.deepEqual(emailsRequested({ item: 'Copy of their email of 16/09/2026' }, all, opts).map((e) => e.id), ['b']);
  // No "our" or "their": every email of that day.
  assert.deepEqual(emailsRequested({ item: 'The email of 16 Sep' }, all, opts).map((e) => e.id), ['a', 'b']);
});

test('the review’s own email_date is used when the words name none', () => {
  assert.deepEqual(emailsRequested({ item: 'Copy of the chaser', email_date: '2026-09-20' }, all, opts).map((e) => e.id), ['c']);
});

test('nothing when it is not an email, has no date, two dates, or none that day', () => {
  assert.deepEqual(emailsRequested({ item: 'Tenancy agreement dated 16 September 2026' }, all, opts), []);
  assert.deepEqual(emailsRequested({ item: 'Copy of our email' }, all, opts), []);
  assert.deepEqual(emailsRequested({ item: 'Our emails of 16 and 20 September' }, all, opts), []);
  assert.deepEqual(emailsRequested({ item: 'Copy of our email of 17 September 2026' }, all, opts), []);
});

test('a forward is dated by the day it was sent, and two copies of one email go once', () => {
  assert.equal(sentDay({ received_at: '2026-09-18T10:00:00Z', analysis: { sent_on: '2026-09-16' } }), '2026-09-16');
  assert.equal(sentDay({ received_at: '2026-09-15T23:30:00Z' }), '2026-09-16'); // BST: the UK day
  const copy = { ...ours16, id: 'a2', direction: 'inbound', received_at: '2026-09-16T09:01:00Z' };
  assert.deepEqual(emailsRequested({ item: 'Copy of our 16 September email' }, [ours16, copy], opts).map((e) => e.id), ['a']);
});

test('the copy carries the headers and the whole email', () => {
  const t = copyText([ours16], ['Dear E.ON,\n\nOur complaint.']);
  assert.match(t, /^From:    sam@greenco\.co\.uk/);
  assert.match(t, /Sent:    Wed 16 Sep 2026, 10:00/);
  assert.match(t, /Subject: Stage 2\n\nDear E\.ON,\n\nOur complaint\.$/);
});

test('the PDF is well formed and the same text makes the same bytes', () => {
  const a = textPdf({ title: 'Email of Tue 16 Sep 2026', text: 'Amount £120.50 – “quoted” (a) \\ b' });
  const b = textPdf({ title: 'Email of Tue 16 Sep 2026', text: 'Amount £120.50 – “quoted” (a) \\ b' });
  assert.ok(a.equals(b));
  const s = a.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  // The xref offset points at the xref table.
  const at = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(at, at + 4), 'xref');
  assert.match(s, /\\243120\.50 \\226 \\223quoted\\224 \\\(a\\\) \\\\ b/);
});

test('long lines wrap at a space, and a long word is cut', () => {
  const lines = wrapText(`${'word '.repeat(40)}\n\n${'x'.repeat(LINE_CHARS + 5)}`);
  assert.ok(lines.every((l) => l.length <= LINE_CHARS));
  assert.ok(lines.includes(''));
  assert.equal(lines.at(-1), 'x'.repeat(5));
});
