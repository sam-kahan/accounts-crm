import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWatchedEmail, domainOf } from '../src/services/mailWatch.js';

const ctx = {
  ourDomain: 'greenco.co.uk',
  threads: new Map([['thread-1', 'complaint-1']]),
  orgDomains: new Set(['livingcity.co.uk']),
};
const email = (over = {}) => ({
  senderEmail: 'someone@example.org', toAddresses: ['accounts@greenco.co.uk'],
  subject: 'Hello', bodyPreview: '', conversationId: 'other', ...over,
});

test('a reply in a thread already on a complaint is filed there with certainty', () => {
  assert.deepEqual(routeWatchedEmail(email({ conversationId: 'thread-1' }), ctx),
    { method: 'thread', complaintId: 'complaint-1' });
});

test('mail to or from an organisation with an open complaint is kept for the AI', () => {
  assert.equal(routeWatchedEmail(email({ senderEmail: 'crm@livingcity.co.uk' }), ctx).method, 'watch');
  assert.equal(routeWatchedEmail(email({
    senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['info@LivingCity.co.uk'],
  }), ctx).method, 'watch');
});

test('our own email to an outside address mentioning a complaint may be a new complaint', () => {
  const r = routeWatchedEmail(email({
    senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['complaints@council.gov.uk'],
    subject: 'Formal Complaint (Stage 1) - 12 High St',
  }), ctx);
  assert.equal(r.method, 'watch_new');
});

test('everything else is left alone and never stored', () => {
  assert.equal(routeWatchedEmail(email(), ctx), null);
  // internal email about a complaint: not to an outside organisation
  assert.equal(routeWatchedEmail(email({
    senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['accounts@greenco.co.uk'], subject: 'complaint notes',
  }), ctx), null);
  // an outsider's email that merely mentions a complaint
  assert.equal(routeWatchedEmail(email({ subject: 'Complaint about our service' }), ctx), null);
});

test('domainOf is case-insensitive and safe on junk', () => {
  assert.equal(domainOf('A@LivingCity.CO.UK'), 'livingcity.co.uk');
  assert.equal(domainOf(null), '');
  assert.equal(domainOf('nodomain'), '');
});

import { couldBeOurComplaint } from '../src/services/pastComplaints.js';

test('past search: only threads with an email from us to an outside party are read', () => {
  const us = 'greenco.co.uk';
  assert.equal(couldBeOurComplaint([
    { senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['crm@livingcity.co.uk'] },
  ], us), true);
  assert.equal(couldBeOurComplaint([
    { senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['accounts@greenco.co.uk'] },
    { senderEmail: 'tenant@gmail.com', toAddresses: ['accounts@greenco.co.uk'] },
  ], us), false);
});
