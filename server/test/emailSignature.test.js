import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSignature, signedEmail, withoutSignOff, signatureImages, DISCLAIMER } from '../src/lib/emailSignature.js';

const SAM = {
  name: 'Sam Kahan', post_nominals: 'MAAT', job_title: 'Finance Director',
  direct_line: '0161 850 8687', office_phone: '0161 708 8629', email: 'sam.kahan@greenco.co.uk',
};

test('the signature is the sender’s own details, as on their Outlook signature', () => {
  const { text, html } = buildSignature(SAM);
  assert.equal(text, [
    'Kind regards,', '', 'Sam Kahan MAAT', 'Finance Director', '',
    'Direct Line 0161 850 8687', 'Office 0161 708 8629', 'Email sam.kahan@greenco.co.uk', '', DISCLAIMER,
  ].join('\n'));
  assert.match(html, /Sam Kahan MAAT<br>Finance Director/);
  assert.match(html, /mailto:sam\.kahan@greenco\.co\.uk/);
  assert.match(html, /cid:sig-banner@greenco/);
  assert.match(html, /cid:sig-trustpilot@greenco/);
});

test('a line not set is left out, and no social icon without its link', () => {
  const { text, html } = buildSignature({ name: 'Jo Bloggs', email: 'jo@greenco.co.uk' });
  assert.equal(text.split('\n').slice(0, 5).join('|'), 'Kind regards,||Jo Bloggs||Email jo@greenco.co.uk');
  assert.doesNotMatch(html, /Direct Line|Office|Mobile|sig-facebook/);
  const withLink = buildSignature(SAM, { links: { facebook: 'https://facebook.com/x' } }).html;
  assert.match(withLink, /href="https:\/\/facebook\.com\/x"[^>]*><img src="cid:sig-facebook@greenco"/);
});

test('what people type is escaped in the HTML', () => {
  assert.match(buildSignature({ ...SAM, job_title: '<b>Boss</b> & co' }).html, /&lt;b&gt;Boss&lt;\/b&gt; &amp; co/);
});

test('the draft’s short sign-off is replaced by the full signature', () => {
  const body = 'Dear E.ON,\n\nPlease see attached.\n\nKind regards,\n\nSam Kahan\nFinance Director\nGreenco';
  const s = signedEmail(body, SAM);
  assert.ok(s.text.startsWith('Dear E.ON,\n\nPlease see attached.\n\nKind regards,\n\nSam Kahan MAAT\nFinance Director'));
  assert.equal(s.text.match(/Kind regards/g).length, 1);
  assert.doesNotMatch(s.text, /\nGreenco\n/);
  assert.match(s.html, /<p[^>]*>Please see attached\.<\/p>/);
  assert.deepEqual(s.attachments.map((a) => a.cid), ['sig-trustpilot@greenco', 'sig-banner@greenco']);
});

test('their own closing word is kept; none gets "Kind regards,"', () => {
  assert.match(signedEmail('Hello,\n\nThanks.\n\nMany thanks,\nSam', SAM).text, /Thanks\.\n\nMany thanks,\n\nSam Kahan MAAT/);
  assert.match(signedEmail('Hello,\n\nA note.', SAM).text, /A note\.\n\nKind regards,\n\nSam Kahan MAAT/);
});

test('a closing with more after it (a P.S.) stays, and no second closing is added', () => {
  const body = 'Hello,\n\nKind regards,\nSam\n\nP.S. ' + 'The meter reading was taken on the day the tenant left the property, as the photo shows.';
  const w = withoutSignOff(body);
  assert.equal(w.kept, true);
  const s = signedEmail(body, SAM).text;
  assert.ok(s.startsWith(body));
  assert.equal(s.match(/Kind regards/g).length, 1);
});

test('no sender: the email goes as written', () => {
  assert.deepEqual(signedEmail('Hi', null), { text: 'Hi', html: undefined, attachments: [] });
});

test('every picture the signature uses is on disk', () => {
  for (const a of signatureImages({ twitter: 'x', facebook: 'x', linkedin: 'x', rightmove: 'x', zoopla: 'x' })) {
    assert.ok(fs.existsSync(a.path), a.path);
  }
});

test('only a real sign-off is replaced: the message, a P.S., a quoted email and "Attached:" are kept', () => {
  const keep = (b) => assert.equal(withoutSignOff(b).kept, true, b);
  keep('Dear Sir,\n\nThanks\n\nPlease confirm the refund by Friday.\nWe hold the meter readings.');
  keep('Hi\n\nBody\n\nThanks,\nSam\n\nP.S. one more thing');
  keep('Hi\n\nBody\n\nKind regards,\nSam\n\n-----Original Message-----\nFrom: x\nSent: y');
  // A closing word as the email's first words is the message.
  assert.equal(withoutSignOff('Many thanks\nfor your reply.').kept, true);
  assert.equal(signedEmail('Many thanks\nfor your reply.', SAM).text.startsWith('Many thanks\nfor your reply.'), true);
  // The attached line stays in what is sent, above the signature.
  const s = signedEmail('Hi\n\nBody\n\nThanks,\nSam\nFinance Director\n\nAttached: bill.pdf; letter.pdf.', SAM).text;
  assert.match(s, /^Hi\n\nBody\n\nAttached: bill\.pdf; letter\.pdf\.\n\nThanks,\n\nSam Kahan MAAT/);
});
