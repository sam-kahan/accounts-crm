import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removalTags, contactByTrack } from '../src/services/trackContact.js';
import { removedOrgFor, tracksOf } from '../src/services/complaintParties.js';
import { planFromAnalysis, ackChangesNothing } from '../src/services/emailAnalysis.js';

// LCS (main) and British Gas (a further organisation) on one complaint.
const complaint = { id: 'c1', org_name: 'LCS', organisation_id: 'o-lcs', reference: 'LCS123' };
const bg = { id: 'p-bg', org_name: 'British Gas', organisation_id: 'o-bg', raised_on: '2026-08-01', reference: 'BG999' };
const orgs = [
  { id: 'o-lcs', name: 'Link Collection Services', complaints_email: 'complaints@lcs.example' },
  { id: 'o-bg', name: 'British Gas', complaints_email: null },
];
const emails = [
  // Theirs, from LCS, on the main part.
  { id: 'e1', direction: 'inbound', sender_email: 'complaints@lcs.example', received_on: '2026-07-10', kind: 'acknowledgement', party_id: null },
  // Ours to LCS.
  { id: 'e2', direction: 'outbound', sender_email: 'accounts@greenco.co.uk', to_addresses: ['complaints@lcs.example'], received_on: '2026-09-20', party_id: null },
  // Ours to British Gas, recorded against them (teaches their domain).
  { id: 'e3', direction: 'outbound', sender_email: 'accounts@greenco.co.uk', to_addresses: ['complaints@bg.example'], received_on: '2026-08-01', party_id: 'p-bg' },
  // British Gas replying, not yet tied to them: known by the domain.
  { id: 'e4', direction: 'inbound', sender_email: 'noreply@bg.example', received_on: '2026-08-05', kind: 'acknowledgement', party_id: null },
  // A colleague's internal note: counts for no one.
  { id: 'e5', direction: 'inbound', sender_email: 'sam@greenco.co.uk', to_addresses: ['accounts@greenco.co.uk'], received_on: '2026-08-06', kind: 'our_email', party_id: null },
];
const events = [
  { id: 'v1', party_id: null, event_date: '2026-07-01', note: 'Chased by phone' }, // before BG: LCS's
  { id: 'v2', party_id: 'p-bg', event_date: '2026-08-10', note: 'Chased' },
  { id: 'v3', party_id: null, event_date: '2026-09-01', note: 'Sent the Stage 2 request from Outlook to LCS.' },
  { id: 'v4', party_id: null, event_date: '2026-09-02', note: 'Chased again' }, // after BG, unnamed: counted for no one
];
const input = { complaint, parties: [bg], orgs, emails, events, ourDomain: 'greenco.co.uk' };

test('taking the main organisation off tags exactly what counted only for it', () => {
  const t = removalTags(input, 'main');
  assert.deepEqual(t.emailIds.sort(), ['e1', 'e2']);
  // v4 counted for no one: tagged, so it never becomes British Gas's.
  assert.deepEqual(t.eventIds.sort(), ['v1', 'v3', 'v4']);
  assert.deepEqual(t.domains, ['lcs.example']);
});

test('what British Gas had is unchanged once LCS is taken off and BG moves up', () => {
  const before = contactByTrack(input).get('p-bg');
  const t = removalTags(input, 'main');
  const promoted = { ...complaint, ...bg, id: 'c1' };
  const after = contactByTrack({
    complaint: promoted, parties: [], orgs,
    emails: emails.filter((e) => !t.emailIds.includes(e.id)).map((e) => ({ ...e, party_id: null })),
    events: events.filter((e) => !t.eventIds.includes(e.id)).map((e) => ({ ...e, party_id: null })),
    ourDomain: 'greenco.co.uk',
  }).get('main');
  assert.deepEqual(after, before);
});

test('taking a further organisation off tags its own history, and the emails known by its address', () => {
  const t = removalTags(input, 'p-bg');
  assert.deepEqual(t.emailIds.sort(), ['e3', 'e4']);
  assert.deepEqual(t.eventIds, ['v2']);
  assert.deepEqual(t.domains.sort(), ['bg.example']);
});

test('a free mail service is never remembered as an organisation address', () => {
  const t = removalTags({ ...input, emails: [...emails, { id: 'e6', direction: 'inbound', sender_email: 'tenant@gmail.com', received_on: '2026-07-02', party_id: null }] }, 'main');
  assert.ok(t.emailIds.includes('e6'));
  assert.deepEqual(t.domains, ['lcs.example']);
});

const removed = [{ name: 'LCS', organisation_id: 'o-lcs', reference: 'LCS123', domains: ['lcs.example'] }];
const afterTracks = tracksOf({ org_name: 'British Gas', organisation_id: 'o-bg', reference: 'BG999' }, [], orgs);

test('a later email from a removed organisation is recognised', () => {
  const r = removedOrgFor({ removed, tracks: afterTracks, analysis: { kind: 'acknowledgement', author_org: 'LCS' }, email: { sender_email: 'x@lcs.example' }, ourDomain: 'greenco.co.uk' });
  assert.equal(r.org.name, 'LCS');
  assert.ok(!r.conflict);
  // By their reference alone.
  const r2 = removedOrgFor({ removed, tracks: afterTracks, analysis: { kind: 'stage1_response', their_reference: 'lcs-123' }, email: { sender_email: 'info@other.example' }, ourDomain: 'greenco.co.uk' });
  assert.equal(r2.org.name, 'LCS');
});

test('an email from the organisation still on it is read as usual', () => {
  assert.equal(removedOrgFor({ removed, tracks: afterTracks, analysis: { kind: 'acknowledgement', author_org: 'British Gas', their_reference: 'BG999' }, email: { sender_email: 'x@bg.example' }, ourDomain: 'greenco.co.uk' }), null);
});

test('signs pointing at both a removed and a remaining organisation wait for a person', () => {
  const r = removedOrgFor({ removed, tracks: afterTracks, analysis: { kind: 'acknowledgement', author_org: 'British Gas' }, email: { sender_email: 'x@lcs.example' }, ourDomain: 'greenco.co.uk' });
  assert.ok(r.conflict);
});

test('our email only to the removed organisation is theirs; one also to the remaining one is not', () => {
  const only = removedOrgFor({ removed, tracks: tracksOf({ org_name: 'British Gas', organisation_id: 'o-bg' }, [], [{ id: 'o-bg', name: 'British Gas', complaints_email: 'c@bg.example' }]), analysis: { kind: 'our_email' }, email: { to_addresses: ['complaints@lcs.example'] }, ourDomain: 'greenco.co.uk' });
  assert.equal(only.org.name, 'LCS');
  const both = removedOrgFor({ removed, tracks: tracksOf({ org_name: 'British Gas', organisation_id: 'o-bg' }, [], [{ id: 'o-bg', name: 'British Gas', complaints_email: 'c@bg.example' }]), analysis: { kind: 'our_email' }, email: { to_addresses: ['complaints@lcs.example', 'c@bg.example'] }, ourDomain: 'greenco.co.uk' });
  assert.equal(both, null);
});

test('a removed entry for an organisation that is on the complaint again is ignored', () => {
  const tracks = tracksOf({ org_name: 'LCS', organisation_id: 'o-lcs' }, [], orgs);
  assert.equal(removedOrgFor({ removed, tracks, analysis: { kind: 'acknowledgement', author_org: 'LCS' }, email: { sender_email: 'x@lcs.example' }, ourDomain: 'greenco.co.uk' }), null);
});

// The OVO case: an automatic "we aim to reply within 2 working days" to our
// Stage 2 request, read with medium confidence.
const ovo = { stage: 'stage_2', raised_on: '2026-07-14', stage_started_on: '2026-09-29', acknowledged_on: '2026-07-15', responded_on: null };
const ack = { kind: 'acknowledgement', confidence: 'medium', from_organisation: true, sent_on: '2026-09-29',
  summary: 'OVO’s automated reply thanks us for getting in touch and says it aims to reply within 2 working days.' };
const subject = 'RE: 28131442 – Request for Stage 2 review: our complaint of 14 July 2026';

test('an unsure acknowledgement that can set no date is filed by itself', () => {
  assert.ok(ackChangesNothing(ovo, ack, subject));
  const plan = planFromAnalysis(ovo, ack, { today: '2026-09-29', text: subject });
  assert.equal(plan.auto, true);
  assert.deepEqual(plan.changes, {});
  assert.equal(plan.event, null);
});

test('an unsure acknowledgement still waits when it could be the first one, or reads like a response', () => {
  const s1 = { ...ovo, stage: 'stage_1', acknowledged_on: null };
  assert.equal(planFromAnalysis(s1, ack, { today: '2026-09-29', text: subject }).auto, false);
  assert.equal(planFromAnalysis(ovo, ack, { today: '2026-09-29', text: `${subject}\nThis is our final response to your complaint.` }).auto, false);
  assert.equal(planFromAnalysis(ovo, ack, { today: '2026-09-29', text: `${subject}\nWe have partially upheld your complaint.` }).auto, false);
  // Not certainly this organisation's part (a complaint with two): waits.
  assert.equal(planFromAnalysis(ovo, ack, { today: '2026-09-29', text: subject, soleTrack: false }).auto, false);
  // Low confidence never.
  assert.equal(planFromAnalysis(ovo, { ...ack, confidence: 'low' }, { today: '2026-09-29', text: subject }).auto, false);
});

test('an organisation added back by name is read as usual again', () => {
  const tracks = tracksOf({ org_name: 'British Gas', organisation_id: 'o-bg' }, [{ id: 'p2', org_name: 'LCS', organisation_id: null }], orgs);
  assert.equal(removedOrgFor({ removed, tracks, analysis: { kind: 'acknowledgement', author_org: 'LCS' }, email: { sender_email: 'x@lcs.example' }, ourDomain: 'greenco.co.uk' }), null);
});

import { offEmail } from '../src/services/complaintRecheck.js';
test('the re-check leaves out a removed organisation\'s emails', () => {
  const rm = [{ name: 'LCS', domains: ['lcs.example'] }];
  assert.equal(offEmail({ removed_org: 'LCS' }, [], 'greenco.co.uk'), true);
  assert.equal(offEmail({ sender_email: 'Info <info@lcs.example>' }, rm, 'greenco.co.uk'), true);
  assert.equal(offEmail({ sender_email: 'x@bg.example' }, rm, 'greenco.co.uk'), false);
  assert.equal(offEmail({ sender_email: 'a@greenco.co.uk', to_addresses: ['c@lcs.example'] }, rm, 'greenco.co.uk'), true);
  assert.equal(offEmail({ sender_email: 'a@greenco.co.uk', to_addresses: ['c@lcs.example', 'c@bg.example'] }, rm, 'greenco.co.uk'), false);
  assert.equal(offEmail({ sender_email: 'a@greenco.co.uk', to_addresses: [] }, rm, 'greenco.co.uk'), false);
});
