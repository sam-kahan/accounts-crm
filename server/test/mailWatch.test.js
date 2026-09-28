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

import { matchOrgName, postcodeOf, findExistingComplaint } from '../src/services/orgMatch.js';

const ORGS = [
  { id: 'o1', name: 'Livingcity Asset Management Limited' },
  { id: 'o2', name: 'E.ON Next' },
  { id: 'o3', name: 'Manchester City Council' },
  { id: 'o4', name: 'Manchester Metropolitan University' },
];

test('organisation names match exactly or by an unambiguous shortening', () => {
  assert.equal(matchOrgName(ORGS, 'LivingCity')?.id, 'o1');
  assert.equal(matchOrgName(ORGS, 'Livingcity Asset Management Ltd')?.id, 'o1');
  assert.equal(matchOrgName(ORGS, 'E.ON Next')?.id, 'o2');
  assert.equal(matchOrgName(ORGS, 'Manchester'), null, 'two Manchesters: ambiguous, so no match');
  assert.equal(matchOrgName(ORGS, 'EON'), null, 'too short to trust');
  assert.equal(matchOrgName(ORGS, 'Urban Bubble'), null);
});

test('postcodes are read and normalised', () => {
  assert.equal(postcodeOf('Apartment 78, 68 Falkner Street, Liverpool, L8 7AD'), 'L8 7AD');
  assert.equal(postcodeOf('flat 2, m27 6nj'), 'M27 6NJ');
  assert.equal(postcodeOf('no postcode here'), null);
});

test('a found complaint already in the system is recognised', () => {
  const complaints = [{ id: 'c1', org_name: 'Livingcity Asset Management Limited', organisation_id: 'o1',
    property: 'Apartment 78 Falkner Place, 68 Falkner Street, Liverpool, L8 7AD', raised_on: '2026-09-28' }];
  assert.equal(findExistingComplaint(complaints, ORGS, {
    org_name: 'LivingCity', property: 'Apartment 78 Falkner Place, Liverpool, L8 7AD', raised_on: '2026-09-28',
  })?.id, 'c1');
  // Same property, different organisation (Urban Bubble): a separate complaint.
  assert.equal(findExistingComplaint(complaints, ORGS, {
    org_name: 'Urban Bubble', property: 'Apt 78 Falkner Place, L8 7AD', raised_on: '2026-09-04',
  }), null);
});

import { groupCandidates, mergeExtracted, sameIssue } from '../src/services/orgMatch.js';

test('threads about the same issue are grouped into one complaint', () => {
  const c = (id, x, last) => ({ id, extracted: x, first_at: `${x.raised_on}T09:00:00Z`, last_at: last, message_count: 2 });
  const a = c('a', { org_name: 'E.ON Next', property: '58 Lawefield Crescent, M27 6NJ', raised_on: '2026-08-01', stage: 'stage_1', state: 'open', summary: 'First complaint.' }, '2026-08-10T00:00:00Z');
  const b = c('b', { org_name: 'EON Next Ltd', property: '58 Lawefield Cres, Clifton, M27 6NJ', raised_on: '2026-09-24', stage: 'stage_2', state: 'open', responded_on: '2026-09-20', summary: 'Escalated.' }, '2026-09-26T00:00:00Z');
  const other = c('x', { org_name: 'E.ON Next', property: '87 Spekeland Road, L7 6HY', raised_on: '2026-08-18', stage: 'stage_1', state: 'open' }, '2026-09-01T00:00:00Z');
  assert.equal(sameIssue(a.extracted, b.extracted), true, 'same org, same postcode');
  assert.equal(sameIssue(a.extracted, other.extracted), false, 'same org, different property');
  const groups = groupCandidates([b, other, a]);
  assert.equal(groups.length, 2);
  const g = groups.find((x) => x.length === 2);
  assert.deepEqual(g.map((x) => x.id), ['a', 'b'], 'oldest first');
  const m = mergeExtracted(g);
  assert.equal(m.raised_on, '2026-08-01', 'earliest date');
  assert.equal(m.stage, 'stage_2', 'furthest stage');
  assert.equal(m.responded_on, '2026-09-20');
});
