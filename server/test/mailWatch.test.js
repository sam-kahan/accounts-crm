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

test('mail with an organisation we have a complaint with goes to the AI only if it is about a complaint', () => {
  const withMarkers = { ...ctx, markers: ['gc-c-rb2ngy', 'l8 7ad'] };
  // an ordinary bill or reminder: never read by the AI
  assert.equal(routeWatchedEmail(email({ senderEmail: 'crm@livingcity.co.uk', subject: 'Your statement' }), withMarkers), null);
  assert.equal(routeWatchedEmail(email({
    senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['info@LivingCity.co.uk'], subject: 'Payment',
  }), withMarkers), null);
  // about a complaint: by its words, its reference, or its property postcode
  assert.equal(routeWatchedEmail(email({ senderEmail: 'crm@livingcity.co.uk', subject: 'Your complaint' }), withMarkers).method, 'watch');
  assert.equal(routeWatchedEmail(email({ senderEmail: 'crm@livingcity.co.uk', subject: 'Stage 2 review' }), withMarkers).method, 'watch');
  assert.equal(routeWatchedEmail(email({ senderEmail: 'crm@livingcity.co.uk', bodyPreview: 'Re GC-C-RB2NGY: we have looked into' }), withMarkers).method, 'watch');
  assert.equal(routeWatchedEmail(email({
    senderEmail: 'sam.kahan@greenco.co.uk', toAddresses: ['info@LivingCity.co.uk'], subject: 'Apt 78, L8 7AD',
  }), withMarkers).method, 'watch');
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
  // "City Council" is a generic ending; "Metropolitan University" is not.
  // A bare place name is not its council: the place turns up in every address.
  assert.equal(matchOrgName(ORGS, 'Manchester'), null);
  assert.equal(matchOrgName([...ORGS, { id: 'o5', name: 'Manchester Council' }], 'Manchester'), null, 'two councils: ambiguous');
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

import { sameOrgName } from '../src/services/orgMatch.js';

test('a shortened name matches only when what it leaves off is generic', () => {
  assert.equal(sameOrgName('LivingCity', 'Livingcity Asset Management Limited'), true);
  assert.equal(sameOrgName('E.ON Next', 'EON Next Ltd'), true);
  assert.equal(sameOrgName('Liverpool', 'Liverpool Mutual Homes'), false);
  assert.equal(sameOrgName('Salford', 'Salford City Council'), false);
});

test('different postcodes are never the same issue, and a postcode-less thread cannot bridge two', () => {
  const c = (id, pc, d) => ({ id, first_at: `${d}T09:00:00Z`,
    extracted: { org_name: 'Bury Council', property: pc ? `1 Road, ${pc}` : '1 Road', raised_on: d } });
  const groups = groupCandidates([c('a', 'BL9 0AA', '2026-05-01'), c('b', null, '2026-05-05'), c('c', 'BL8 1XX', '2026-05-08')]);
  const withA = groups.find((g) => g.some((x) => x.id === 'a'));
  assert.ok(!withA.some((x) => x.id === 'c'), 'two properties never in one group');
  const complaints = [{ id: 'k', org_name: 'Bury Council', property: '9 Lane, BL9 0AA', raised_on: '2026-05-02' }];
  assert.equal(findExistingComplaint(complaints, [], { org_name: 'Bury Council', property: '3 St, BL8 1XX', raised_on: '2026-05-03' }), null);
});

import { unitOf, sameProperty, addressNumbers } from '../src/services/orgMatch.js';

test('unitOf reads the flat or house number from an address', () => {
  assert.equal(unitOf('Apartment 309, 2 Moorfields, Liverpool, L2 2BT'), '309');
  assert.equal(unitOf('Apt 78 Falkner Place, 68 Falkner Street, L8 7AD'), '78');
  assert.equal(unitOf('78 Falkner Place, 68 Falkner Street, Liverpool, L8 7AE'), '78');
  assert.equal(unitOf('Flat 3B, 10 High Street'), '3B');
  assert.equal(unitOf('84 Waverley Crescent, Droylsden, M43 7WL'), '84');
  assert.equal(unitOf('Rose Cottage, Mill Lane'), null);
  assert.equal(unitOf(null), null);
});

test('two flats at the same postcode are two issues, not one', () => {
  const a = { org_name: 'Liverpool City Council', property: 'Apartment 309, 2 Moorfields, Liverpool, L2 2BT', raised_on: '2026-07-09' };
  const b = { org_name: 'Liverpool City Council', property: 'Apartment 326, 2 Moorfields, Liverpool, L2 2BT', raised_on: '2026-07-10' };
  assert.equal(sameIssue(a, b), false);
  assert.equal(sameIssue(a, { ...b, property: 'Apt 309, 2 Moorfields, L2 2BT' }), true);
  const groups = groupCandidates([
    { id: '1', first_at: '2026-07-09', extracted: a },
    { id: '2', first_at: '2026-07-10', extracted: b },
  ]);
  assert.equal(groups.length, 2);
  // The same flat written two ways is still found as the complaint on file.
  const onFile = [{ id: 'c1', org_name: 'LivingCity', property: 'Apartment 78 Falkner Place, 68 Falkner Street, Liverpool, L8 7AD', raised_on: '2026-09-28' }];
  assert.equal(findExistingComplaint(onFile, [], { org_name: 'LivingCity', property: '78 Falkner Place, L8 7AD' })?.id, 'c1');
  assert.equal(findExistingComplaint(onFile, [], { org_name: 'LivingCity', property: 'Apartment 73, 68 Falkner Street, L8 7AD' }), null);
});

test('the same property written more or less fully is one property; two flats in a block are two', () => {
  assert.equal(sameProperty('Flat 2, 10 X Road, M1 1AA', '10 X Road, M1 1AA'), true);
  assert.equal(sameProperty('Apartment 309, 2 Moorfields, L2 2BT', '2 Moorfields, L2 2BT'), true);
  assert.equal(sameProperty('Apartment 309, 2 Moorfields, L2 2BT', 'Apartment 326, 2 Moorfields, L2 2BT'), false);
  assert.equal(sameProperty('Apartment 78 Falkner Place, 68 Falkner Street, L8 7AD', '78 Falkner Place, L8 7AD'), true);
  assert.equal(sameProperty('Apartment 78 Falkner Place, 68 Falkner Street, L8 7AD', 'Apartment 73, 68 Falkner Street, L8 7AD'), false);
  assert.equal(sameProperty('A08 and A09 Bateson Building, L1 1AA', 'A09 Bateson Building, L1 1AA'), true);
  assert.equal(sameProperty('84 Waverley Crescent, M43 7WL', '86 Waverley Crescent, M43 7WL'), false);
  assert.equal(sameProperty('10 X Road, M1 1AA', '10 X Road, M2 2BB'), false);
  assert.deepEqual([...addressNumbers('Apartment 309, 2 Moorfields, L2 2BT')].sort(), ['2', '309']);
});

test('a bare place name is never taken for its council', () => {
  assert.equal(sameOrgName('Liverpool', 'Liverpool City Council'), false);
  assert.equal(sameOrgName('Manchester', 'Manchester City Council'), false);
  assert.equal(sameOrgName('LivingCity', 'Livingcity Asset Management Limited'), true);
});

import { issueMatch, accountsOf } from '../src/services/orgMatch.js';

test('the account number decides: same account is the same complaint, different accounts are not', () => {
  const onFile = { org_name: 'British Gas', subject: 'Incorrect final billing on account A43325464', property: null, raised_on: '2026-09-05' };
  // the case in the screenshot: different addresses, raised the same fortnight, no shared account
  const benedict = { org_name: 'British Gas', property: '6 Benedict Street, Bootle, L20 2EN', raised_on: '2026-09-03', account_numbers: ['850012345678'] };
  const waverley = { org_name: 'British Gas', property: '84 Waverley Crescent, Droylsden, M43 7WL', raised_on: '2026-09-09' };
  assert.equal(issueMatch(onFile, benedict).same, false);
  assert.equal(issueMatch(onFile, waverley).same, false);
  // the same account number, written differently, is certain
  const same = { org_name: 'British Gas Ltd', property: '1 Elsewhere Rd, M1 1AA', account_numbers: ['A433 25464'] };
  assert.deepEqual(issueMatch(onFile, same), { same: true, certain: true });
  // same address, different accounts: different complaints
  const a = { org_name: 'OVO Energy', property: '165 Longton Lane, L35 8NU', account_numbers: ['111111'] };
  const b = { org_name: 'OVO Energy', property: '165 Longton Lane, L35 8NU', account_numbers: ['222222'] };
  assert.equal(issueMatch(a, b).same, false);
  // groups keep different accounts apart
  assert.equal(groupCandidates([{ id: '1', extracted: a }, { id: '2', extracted: b }]).length, 2);
  // amounts and dates in a subject are not account numbers
  assert.deepEqual([...accountsOf({ subject: 'Refund of £1,297.55 by 01/09/2026' })], []);
});

test('a debt collector quoting the supplier\'s account number is the same complaint', () => {
  const bg = { org_name: 'British Gas', account_numbers: ['850012345678'], property: '6 Benedict Street, L20 2EN' };
  const lcs = { org_name: 'LCS (1st Locate UK Ltd)', account_numbers: ['8500 1234 5678'] };
  assert.deepEqual(issueMatch(bg, lcs), { same: true, certain: true });
  // but a different organisation with no shared account is not
  assert.equal(issueMatch(bg, { org_name: 'LCS', property: '6 Benedict Street, L20 2EN' }).same, false);
});

import { sameAddressText } from '../src/services/orgMatch.js';

test('the same address written with and without its postcode is the same property', () => {
  assert.equal(sameAddressText('Apartment 326, 2 Moorfields', 'Apt 326, 2 Moorfields, Liverpool, L2 2BT'), true);
  assert.equal(sameAddressText('Apartment 326, 2 Moorfields', 'Apartment 309, 2 Moorfields, L2 2BT'), false);
  assert.equal(sameAddressText('84 Waverley Crescent', '84 Other Crescent, M43 7WL'), false); // same number, different street
  assert.equal(sameAddressText('Moorfields', '2 Moorfields'), false); // no numbers on one side: can't tell
  const a = { org_name: 'CDER Group', property: 'Apartment 326, 2 Moorfields', raised_on: '2026-07-28' };
  const b = { org_name: 'CDER Group', property: 'Apartment 326, 2 Moorfields, Liverpool, L2 2BT', raised_on: '2026-08-12' };
  assert.deepEqual(issueMatch(a, b), { same: true, certain: true });
});

import { buildNumberIndex, complaintByNumber, complaintsQuoted } from '../src/services/numberMatch.js';

const nIndex = buildNumberIndex([
  { id: 'eon', account_numbers: ['A-49ED9909'], reference: null, ref_code: 'GC-C-8UD28A', party_refs: [] },
  { id: 'bg', account_numbers: ['8500 1234 5678'], reference: 'BG-778812', ref_code: 'GC-C-XNAQHC', party_refs: ['LCS-55120'] },
  { id: 'short', account_numbers: ['12345'], reference: 'ABCDEF', ref_code: null, party_refs: [] },
]);

test('an email quoting an open complaint’s account number is filed on it, however the number is written', () => {
  assert.equal(complaintByNumber('RE: A-49ED9909 final bill', nIndex), 'eon');
  assert.equal(complaintByNumber('Account a49ed9909', nIndex), 'eon');
  assert.equal(complaintByNumber('Your account 8500-1234-5678 is overdue', nIndex), 'bg');
  assert.equal(complaintByNumber('Ref 850012345678', nIndex), 'bg');
  assert.equal(complaintByNumber('Our client ref LCS 55120', nIndex), 'bg'); // the debt collector’s own reference
  assert.equal(complaintByNumber('Re complaint GC-C-8UD28A', nIndex), 'eon');
});

test('a number inside a longer one, or a short/plain reference, never files an email', () => {
  assert.equal(complaintByNumber('Call 0850012345678 today', nIndex), null);
  assert.equal(complaintByNumber('Invoice 9A-49ED99091', nIndex), null);
  assert.equal(complaintByNumber('Order 12345, ref ABCDEF', nIndex), null);
});

test('numbers of two complaints: not filed by number (the reading decides)', () => {
  assert.equal(complaintsQuoted('A-49ED9909 and 8500 1234 5678', nIndex).size, 2);
  assert.equal(complaintByNumber('A-49ED9909 and 8500 1234 5678', nIndex), null);
});

test('watching: any sender quoting an open complaint’s number is filed on it', () => {
  const r = routeWatchedEmail(email({ senderEmail: 'agent@lcs-collections.co.uk', subject: 'Balance due A-49ED9909' }), { ...ctx, numbers: nIndex });
  assert.deepEqual(r, { method: 'account', complaintId: 'eon' });
});

test('a reply in a thread of a deleted complaint is left alone', () => {
  const r = routeWatchedEmail(email({ conversationId: 'gone-thread', subject: 'Re: complaint A-49ED9909' }),
    { ...ctx, numbers: nIndex, ignoredThreads: new Set(['gone-thread']) });
  assert.equal(r, null);
});

test('an organisation written slightly differently is the one on file, never a new one', async () => {
  const { matchOrg } = await import('../src/services/orgMatch.js');
  const same = [
    ['CDER', 'CDER Group'],
    ['Octopus', 'Octopus Energy'],
    ['OVO', 'OVO Energy'],
    ['OVO Energy Ltd', 'OVO Energy'],
    ['Lowell', 'Lowell Financial Ltd'],
    ['UK Power Networks', 'UK Power Networks Ltd'],
    ['Liverpool Council', 'Liverpool City Council'],
    ['Sefton Council', 'Sefton Metropolitan Borough Council'],
    ['Brittish Gas Services', 'British Gas Services'],
    ['British Gas', 'British Gas Services Ltd'],
  ];
  for (const [a, b] of same) assert.equal(sameOrgName(a, b), true, `${a} / ${b}`);
  const different = [
    ['Liverpool', 'Liverpool City Council'],
    ['Liverpool', 'Liverpool Homes'],
    ['Scottish Power', 'Scottish Water'],
    ['EON', 'E.ON Next'],
    ['Liverpool City Council', 'Knowsley Council'],
    ['Manchester City Council', 'Manchester Metropolitan University'],
    ['Places for People', 'Plus Dane'],
  ];
  for (const [a, b] of different) assert.equal(sameOrgName(a, b), false, `${a} / ${b}`);
  // Two saved organisations it could be: neither.
  assert.equal(matchOrgName([{ id: 'a', name: 'Scottish Power' }, { id: 'b', name: 'Scottish Water' }], 'Scottish'), null);
  // Name not recognised, but their complaints address is on file: that one.
  const orgs = [
    { id: 'lcc', name: 'Liverpool City Council', complaints_email: 'complaints@liverpool.gov.uk' },
    { id: 'bg', name: 'British Gas', complaints_email: 'complaints@britishgas.co.uk' },
  ];
  assert.equal(matchOrg(orgs, { name: 'Council Tax Team', domains: ['liverpool.gov.uk'] })?.id, 'lcc');
  // Never by a webmail domain, our own, or one two organisations share.
  assert.equal(matchOrg(orgs, { name: 'Someone', domains: ['gmail.com'] }), null);
  assert.equal(matchOrg(orgs, { name: 'Someone', domains: ['greenco.co.uk'], ourDomain: 'greenco.co.uk' }), null);
  assert.equal(matchOrg([...orgs, { id: 'x', name: 'Other', complaints_email: 'x@liverpool.gov.uk' }], { name: 'Someone', domains: ['liverpool.gov.uk'] }), null);
});

test('an account number filed as "their reference" still matches the same account', async () => {
  const { issueMatch } = await import('../src/services/orgMatch.js');
  const bg = { org_name: 'British Gas', reference: 'A34025850', account_numbers: [], property: '4 Treelands Walk, Salford, M5 3FU' };
  const lcs = { org_name: 'LCS (1st Locate UK Ltd)', reference: '46890915', account_numbers: ['A34025850'], property: '4 Treelands Walk, Salford, M5 3FU' };
  assert.deepEqual(issueMatch(bg, lcs), { same: true, certain: true });
  assert.deepEqual(issueMatch(lcs, bg), { same: true, certain: true });
  // Several references in one field are read word by word.
  assert.equal(issueMatch({ org_name: 'X', reference: 'Council Tax ref 58669277 / CDER Reference 27308462' },
    { org_name: 'Y', account_numbers: ['58669277'] }).same, true);
  // Two different complaints' case references across organisations are not an account.
  assert.equal(issueMatch({ org_name: 'X', reference: '46890915' }, { org_name: 'Y', reference: '46890915' }).same, false);
});
