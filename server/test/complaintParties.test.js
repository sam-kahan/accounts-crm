import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackForEmail, overallState, anyTrackOpen } from '../src/services/complaintParties.js';
import { deriveStatus, procedureSteps, effectiveRule, reviewSignature, trackOpen } from '../src/services/complaintRules.js';
import { planFromAnalysis } from '../src/services/emailAnalysis.js';
import { searchTermsFor } from '../src/services/accountNumbers.js';
import { findExistingComplaint } from '../src/services/orgMatch.js';

// British Gas is the main organisation; LCS collects the debt for them.
const complaint = {
  id: 'c1', organisation_id: 'o-bg', org_name: 'British Gas', org_type: 'energy', reference: 'BG-778812',
  state: 'open', stage: 'stage_1', raised_on: '2026-09-01', stage_started_on: '2026-09-01',
};
const lcs = {
  id: 'p1', complaint_id: 'c1', organisation_id: 'o-lcs', org_name: 'LCS', org_type: 'other',
  reference: 'LCS-55120', state: 'open', stage: 'stage_1', raised_on: '2026-09-03', stage_started_on: '2026-09-03',
};
const orgs = [
  { id: 'o-bg', name: 'British Gas Trading Ltd', complaints_email: 'complaints@britishgas.co.uk' },
  { id: 'o-lcs', name: 'LCS', complaints_email: 'disputes@lcs-collections.co.uk' },
];
const ask = (analysis, email = {}) =>
  trackForEmail({ complaint, parties: [lcs], orgs, analysis, email, ourDomain: 'greenco.co.uk' });

test('one organisation: every email is on the main track, as before', () => {
  const r = trackForEmail({ complaint, parties: [], orgs, analysis: {}, email: {} });
  assert.equal(r.certain, true);
  assert.equal(r.track.party, null);
});

test('the author’s organisation picks the track (LCS writing about a British Gas bill is LCS)', () => {
  const r = ask({ author_org: 'LCS', org_name: 'British Gas' });
  assert.equal(r.track.party.id, 'p1');
  assert.equal(ask({ author_org: 'British Gas' }).track.party, null);
});

test('their reference picks the track', () => {
  assert.equal(ask({ their_reference: 'lcs 55120' }).track.party.id, 'p1');
  assert.equal(ask({ their_reference: 'BG-778812' }).track.party, null);
});

test('the sender’s domain picks the track, but a forward from us says nothing', () => {
  assert.equal(ask({}, { sender_email: 'jo@lcs-collections.co.uk' }).track.party.id, 'p1');
  const fwd = ask({}, { sender_email: 'sam@greenco.co.uk' });
  assert.equal(fwd.track, null);
  assert.match(fwd.reason, /British Gas or LCS/);
});

test('signs that disagree are left for a person, never guessed', () => {
  const r = ask({ author_org: 'LCS', their_reference: 'BG-778812' });
  assert.equal(r.certain, false);
  assert.equal(r.track, null);
  assert.match(r.reason, /more than one/);
});

test('an acknowledgement is planned against the organisation that sent it', () => {
  const a = {
    confidence: 'high', from_organisation: true, kind: 'acknowledgement', sent_on: '2026-09-05',
    their_reference: 'LCS-55120',
  };
  const plan = planFromAnalysis(lcs, a, { today: '2026-09-10' });
  assert.deepEqual(plan.changes, { acknowledged_on: '2026-09-05' });
  // The date checks use THAT organisation's dates: LCS was complained to on
  // 3 Sep, so a 2 Sep letter can't be their acknowledgement.
  const early = planFromAnalysis(lcs, { ...a, sent_on: '2026-09-02' }, { today: '2026-09-10' });
  assert.equal(early.auto, false);
});

test('the complaint stays open while any organisation’s part is', () => {
  const mainDone = { ...complaint, stage: 'resolved' };
  assert.equal(trackOpen(mainDone), false);
  assert.equal(overallState(mainDone, [lcs]), 'open');
  assert.equal(anyTrackOpen(mainDone, [lcs]), true);
  assert.equal(overallState(mainDone, [{ ...lcs, state: 'resolved', stage: 'resolved' }]), 'resolved');
  assert.equal(overallState(complaint, []), 'open');
});

test('a main track that has ended reads as resolved and nothing on it is overdue', () => {
  const mainDone = { ...complaint, stage: 'resolved', response_due: '2020-09-15' };
  const rule = effectiveRule(null, 'energy');
  const st = deriveStatus(mainDone, rule);
  assert.equal(st.status, 'resolved');
  assert.equal(st.needs_chasing, false);
  assert.ok(procedureSteps(mainDone, rule).every((s) => s.state !== 'overdue'));
});

test('a review written before parties existed stays current (same signature)', () => {
  const c = { status: 'awaiting_ack', stage: 'stage_1', state: 'open', response_due: '2026-09-15' };
  assert.equal(reviewSignature(c), reviewSignature({ ...c, parties: [] }));
  assert.notEqual(reviewSignature(c), reviewSignature({ ...c, parties: [{ id: 'p1', stage: 'stage_1' }] }));
});

test('every reference and account number is searched, not just the account', () => {
  const terms = searchTermsFor(
    { account_numbers: ['8500 1234 5678'], reference: 'BG-778812', our_reference: 'GC/42', ref_code: 'GC-C-ABC234' },
    [{ org_name: 'LCS', reference: 'LCS-55120' }],
  );
  assert.deepEqual(terms.map((t) => [t.kind, t.searchable]), [
    ['account', true],
    ['their reference', true],
    ["LCS's reference", true],
    ['our reference', false], // too short to search safely
    ['our complaint code', true],
  ]);
});

test('our GC-C code is searched even when it is all letters', () => {
  const [t] = searchTermsFor({ ref_code: 'GC-C-XNAQHC' });
  assert.equal(t.searchable, true);
});

test('the same reference twice is searched once', () => {
  const terms = searchTermsFor({ reference: 'CR-123456', our_reference: 'cr123456', ref_code: null });
  assert.equal(terms.length, 1);
});

test('a found complaint from the second organisation matches by its name', () => {
  const on = [{ ...complaint, property: '10 High St, L1 1AA', party_names: ['LCS'], party_refs: ['LCS-55120'] }];
  const hit = findExistingComplaint(on, orgs, { org_name: 'LCS', reference: 'LCS-55120', property: null });
  assert.equal(hit?.id, 'c1');
});
