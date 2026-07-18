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
  assert.equal(p.ack_days, 0); // clamped to min
  assert.equal(p.ombudsman_referral_months, 12);
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
