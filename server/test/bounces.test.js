import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBounce, readSmtp2goEvent } from '../src/services/bounces.js';

const O = { ourDomain: 'greenco.co.uk' };

test('an Outlook/Exchange bounce names the address that failed', () => {
  const b = readBounce({
    senderEmail: 'postmaster@greenco.co.uk',
    subject: 'Undeliverable: Complaint GC-C-ABC234',
    bodyText: 'Your message to complaints@britishgas.co.uk couldn\'t be delivered.\ncomplaints wasn\'t found at britishgas.co.uk.\nRemote server returned 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found',
  }, O);
  assert.deepEqual(b.addresses, ['complaints@britishgas.co.uk']);
  assert.match(b.reason, /550 5\.1\.10/);
});

test('a Gmail bounce', () => {
  const b = readBounce({
    senderEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    bodyText: "Address not found\nYour message wasn't delivered to disputes@lcs.co.uk because the address couldn't be found.",
  }, O);
  assert.deepEqual(b.addresses, ['disputes@lcs.co.uk']);
});

test('a standard delivery report (Final-Recipient) and a Postfix one', () => {
  assert.deepEqual(readBounce({
    senderEmail: 'MAILER-DAEMON@mx.example.com', subject: 'Returned mail: see transcript',
    bodyText: 'Reporting-MTA: dns; mx\nFinal-Recipient: rfc822; old.team@council.gov.uk\nStatus: 5.1.1',
  }, O).addresses, ['old.team@council.gov.uk']);
  assert.deepEqual(readBounce({
    senderEmail: 'MAILER-DAEMON@mail.example.net', subject: 'Undelivered Mail Returned to Sender',
    bodyText: '<nobody@agent.co.uk>: host mx.agent.co.uk said: 550 5.1.1 User unknown',
  }, O).addresses, ['nobody@agent.co.uk']);
});

test('our own address is never the one that failed', () => {
  const b = readBounce({
    senderEmail: 'postmaster@greenco.co.uk', subject: 'Undeliverable: hello',
    bodyText: 'From: accounts@greenco.co.uk\nYour message to x@y.co.uk couldn\'t be delivered.',
  }, O);
  assert.deepEqual(b.addresses, ['x@y.co.uk']);
});

test('a delay is not a bounce', () => {
  assert.equal(readBounce({
    senderEmail: 'postmaster@outlook.com', subject: 'Delivery delayed: Complaint',
    bodyText: 'Delivery is delayed to these recipients: a@b.co.uk. The server will keep trying.',
  }, O), null);
  assert.equal(readBounce({
    senderEmail: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Delay)',
    bodyText: 'This is a warning message only. Will retry.',
  }, O), null);
});

test('a real email that mentions a failed delivery is not a bounce', () => {
  assert.equal(readBounce({
    senderEmail: 'complaints@britishgas.co.uk', subject: 'Re: your complaint - letter delivery failed',
    bodyText: 'We tried to send the letter.',
  }, O), null);
});

test('a bounce whose address can’t be read is still flagged', () => {
  const b = readBounce({ senderEmail: 'postmaster@x.com', subject: 'Undeliverable: Complaint', bodyPreview: 'Delivery has failed.' }, O);
  assert.deepEqual(b.addresses, []);
});

test('SMTP2GO: a hard bounce or a rejection is flagged, a soft bounce is not', () => {
  assert.equal(readSmtp2goEvent({ event: 'bounce', bounce: 'hard', rcpt: 'A@B.co.uk', message: '550 no such user', email_id: 'e1' }).address, 'a@b.co.uk');
  assert.equal(readSmtp2goEvent({ event: 'bounce', bounce: 'soft', rcpt: 'a@b.co.uk' }), null);
  assert.ok(readSmtp2goEvent({ event: 'reject', rcpt: 'a@b.co.uk' }));
  assert.equal(readSmtp2goEvent({ event: 'delivered', rcpt: 'a@b.co.uk' }), null);
});

test('an older Exchange bounce with the address on its own line', () => {
  const b = readBounce({
    senderEmail: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@greenco.co.uk',
    subject: 'Undeliverable: Stage 2 request',
    bodyText: 'Delivery has failed to these recipients or groups:\n\nold.box@livingcity.co.uk\nThe email address you entered couldn\'t be found.',
  }, O);
  assert.deepEqual(b.addresses, ['old.box@livingcity.co.uk']);
});

test('a subject alone is not enough: a real email titled "Not delivered" is not swallowed', () => {
  const real = { senderEmail: 'complaints@britishgas.co.uk', subject: 'Not delivered: your parcel', bodyText: 'We could not deliver your parcel today.' };
  assert.equal(readBounce(real, { ...O, full: true }), null);
  assert.equal(readBounce(real, O).unconfirmed, true); // preview only: the full text is read before deciding
  const report = { senderEmail: 'noreply@relay.example', subject: 'Undeliverable: hello', bodyText: 'Remote server returned 550 5.1.1 user unknown for a@b.co.uk' };
  assert.deepEqual(readBounce(report, { ...O, full: true }).addresses, ['a@b.co.uk']);
});
