import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saysAttached, pickAttachments, staleNoReply, datesIn } from '../src/services/draftChecks.js';

const docs = [
  { id: 'a', filename: 'GreencoScan_202609251443.pdf' },
  { id: 'b', filename: 'Bill_42291835 (1).pdf' },
  { id: 'c', filename: '20251114-1013-TenancyAgreement-963759092.pdf' },
];

test('the AI’s named files are attached, matched by name', () => {
  assert.deepEqual(pickAttachments({ body: 'Please find attached the summons and bill.', attach: ['GreencoScan_202609251443.pdf', ' bill_42291835 (1).pdf'] }, docs), ['a', 'b']);
});

test('only what the AI named is picked, never every document (the chooser decides the rest)', () => {
  assert.deepEqual(pickAttachments({ body: 'The summons is attached.', attach: ['summons.pdf'] }, docs), []);
  assert.deepEqual(pickAttachments({ body: 'The summons is attached.' }, docs), []);
  assert.deepEqual(pickAttachments({ body: 'Please confirm the refund.' }, docs), []);
  assert.deepEqual(pickAttachments({ body: 'attached' }, []), []);
});

test('"attached" is read in the message, not in the system’s own Attached: line', () => {
  assert.equal(saysAttached('I enclose the bill.'), true);
  assert.equal(saysAttached('Please see the summons attached.'), true);
  assert.equal(saysAttached('Please confirm.\n\nAttached: a.pdf.\n\nKind regards'), false);
});

test('dates in a sentence, in the ways people write them', () => {
  const today = '2026-09-29';
  assert.deepEqual(datesIn('on 28 September 2026', today), ['2026-09-28']);
  assert.deepEqual(datesIn('on the 28th of Sep', today), ['2026-09-28']);
  assert.deepEqual(datesIn('on 28/09/2026 and 28/09', today), ['2026-09-28', '2026-09-28']);
  assert.deepEqual(datesIn('on 15 December', today), ['2025-12-15']); // no year, would be future: last year
});

test('no reply to something sent yesterday is caught; after 10 working days it is fair to say', () => {
  const today = '2026-09-29';
  const s = staleNoReply('Dear Sir,\n\nWe asked for a refund of the summons charge on 28 September 2026 and have not received a response.\n\nKind regards', today);
  assert.equal(s.date, '2026-09-28');
  assert.match(s.sentence, /not received a response/);
  assert.equal(staleNoReply('We asked on 28/09 and are still waiting.', today).date, '2026-09-28');
  // Mentioned as what we asked for, not as silence: fine.
  assert.equal(staleNoReply('We asked on 28 September 2026 for the £61 to be refunded.', today), null);
  // Weeks ago: fair to say.
  assert.equal(staleNoReply('We wrote on 1 September 2026 and have had no response.', today), null);
});
