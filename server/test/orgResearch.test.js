import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProfile } from '../src/services/orgResearch.js';

test('clamps out-of-range integers and coerces numeric strings', () => {
  const p = normaliseProfile({
    stage1_response_days: '10',
    stage2_response_days: 99999,
    ack_days: -4,
    ombudsman_referral_months: 12,
  });
  assert.equal(p.stage1_response_days, 10);
  assert.equal(p.stage2_response_days, 400); // clamped to max
  assert.equal(p.ack_days, null); // below any real figure: not stated
  assert.equal(p.ombudsman_referral_months, 12);
});

test('a figure the source did not give is null, never 0', () => {
  const p = normaliseProfile({ ack_days: null, stage1_response_days: '', stage2_response_days: 0 });
  assert.equal(p.ack_days, null);
  assert.equal(p.stage1_response_days, null);
  assert.equal(p.stage2_response_days, null);
  assert.equal(p.ombudsman_after_weeks, null);
});

test('rejects non-http(s) URLs (e.g. javascript:)', () => {
  const p = normaliseProfile({
    complaints_url: 'javascript:alert(1)',
    ombudsman_url: 'https://www.lgo.org.uk/',
  });
  assert.equal(p.complaints_url, null);
  assert.equal(p.ombudsman_url, 'https://www.lgo.org.uk/');
});

test('keeps a valid complaints email but drops a malformed one', () => {
  assert.equal(normaliseProfile({ complaints_email: 'x@council.gov.uk' }).complaints_email, 'x@council.gov.uk');
  assert.equal(normaliseProfile({ complaints_email: 'not an email' }).complaints_email, null);
});

test('filters sources to well-formed {title,url} with http(s) URLs', () => {
  const p = normaliseProfile({
    sources: [
      { title: 'Good', url: 'https://example.com/a' },
      { title: 'Bad scheme', url: 'ftp://example.com' },
      { title: 'No url' },
      'garbage',
    ],
  });
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].url, 'https://example.com/a');
});

test('always returns the full shape with safe defaults', () => {
  const p = normaliseProfile({});
  assert.equal(p.procedure_summary, '');
  assert.equal(p.legal_basis, '');
  assert.deepEqual(p.sources, []);
  assert.equal(p.complaints_email, null);
});

test('procedure fields: enums checked, weeks clamped, evidence and unconfirmed filtered', () => {
  const p = normaliseProfile({
    procedure_ref: 'PRO39 V7',
    stage1_clock: 'acknowledgement',
    referral_from: 'whenever',
    ombudsman_after_weeks: 500,
    evidence: { ack_days: 'within 3 working days of receiving it', bogus: 'x', stage1_clock: 42 },
    unconfirmed: ['stage2_response_days', 'not_a_field', 'stage2_response_days'],
  });
  assert.equal(p.procedure_ref, 'PRO39 V7');
  assert.equal(p.stage1_clock, 'acknowledgement');
  assert.equal(p.referral_from, null);
  assert.equal(p.ombudsman_after_weeks, 104);
  assert.deepEqual(p.evidence, { ack_days: 'within 3 working days of receiving it' });
  assert.deepEqual(p.unconfirmed, ['stage2_response_days']);
});
