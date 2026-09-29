import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProfile } from '../src/services/orgResearch.js';

test('refuses out-of-range integers and coerces numeric strings (each quoted)', () => {
  const p = normaliseProfile({
    stage1_response_days: '10',
    stage2_response_days: 99999,
    ack_days: -4,
    ombudsman_referral_months: 12,
    evidence: {
      stage1_response_days: 'within 10 working days',
      stage2_response_days: 'within 99999 working days',
      ack_days: 'within -4 working days',
      ombudsman_referral_months: 'within 12 months of our final response',
    },
  });
  assert.equal(p.stage1_response_days, 10);
  assert.equal(p.stage2_response_days, null); // a misreading, never capped to a date far off
  assert.equal(p.ack_days, null); // below any real figure: not stated
  assert.equal(p.ombudsman_referral_months, 12);
});

test('a date figure needs its quote, and is not one the AI itself calls unconfirmed', () => {
  const p = normaliseProfile({
    ack_days: 3,
    stage1_response_days: 10,
    evidence: { stage1_response_days: 'respond within 10 working days' },
    unconfirmed: [],
  });
  assert.equal(p.ack_days, null);
  assert.ok(p.unconfirmed.includes('ack_days'));
  assert.equal(p.stage1_response_days, 10);
  const q = normaliseProfile({
    stage1_response_days: 10,
    evidence: { stage1_response_days: 'respond within 10 working days' },
    unconfirmed: ['stage1_response_days'],
  });
  assert.equal(q.stage1_response_days, null);
});

test('days are working days only when the source says so: weeks are never converted', () => {
  const p = normaliseProfile({
    stage1_response_days: 40,
    stage2_response_days: 20,
    evidence: {
      stage1_response_days: 'we will send our final response within 8 weeks',
      stage2_response_days: 'within 20 business days',
    },
  });
  assert.equal(p.stage1_response_days, null);
  assert.ok(p.unconfirmed.includes('stage1_response_days'));
  assert.equal(p.stage2_response_days, 20);
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
    evidence: { ack_days: 'within 3 working days of receiving it', bogus: 'x', stage1_clock: 'from the date we acknowledge it' },
    unconfirmed: ['stage2_response_days', 'not_a_field', 'stage2_response_days'],
  });
  assert.equal(p.procedure_ref, 'PRO39 V7');
  assert.equal(p.stage1_clock, 'acknowledgement');
  assert.equal(p.referral_from, null);
  assert.equal(p.ombudsman_after_weeks, null); // out of range: refused
  assert.deepEqual(p.evidence, { ack_days: 'within 3 working days of receiving it', stage1_clock: 'from the date we acknowledge it' });
  assert.ok(p.unconfirmed.includes('stage2_response_days'));
  assert.ok(!p.unconfirmed.includes('not_a_field'));
  assert.equal(p.unconfirmed.filter((k) => k === 'stage2_response_days').length, 1);
});
