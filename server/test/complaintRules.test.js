import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addWorkingDays,
  workingDaysUntil,
  computeResponseDue,
  computeOmbudsmanDeadline,
  deriveStatus,
  effectiveRule,
  ruleFor,
} from '../src/services/complaintRules.js';
import { todayISO } from '../src/lib/dates.js';

test('addWorkingDays skips weekends', () => {
  // 2025-06-06 is a Friday → +1 working day is Monday the 9th.
  assert.equal(addWorkingDays('2025-06-06', 1), '2025-06-09');
});

test('addWorkingDays skips bank holidays', () => {
  // 24 Dec 2025 (Wed); 25th & 26th are bank holidays, 27/28 the weekend,
  // so +2 working days lands on Tue 30 Dec.
  assert.equal(addWorkingDays('2025-12-24', 2), '2025-12-30');
});

test('addWorkingDays with 0/undefined returns the input unchanged', () => {
  assert.equal(addWorkingDays('2025-06-06', 0), '2025-06-06');
  assert.equal(addWorkingDays(null, 5), null);
});

test('workingDaysUntil is 0 for today, negative for the past, positive for the future', () => {
  assert.equal(workingDaysUntil(todayISO()), 0);
  assert.ok(workingDaysUntil('2000-01-01') < 0);
  assert.ok(workingDaysUntil('2099-01-01') > 0);
});

test('computeResponseDue uses the stage-appropriate window', () => {
  const rule = ruleFor('council'); // stage1 10, stage2 20 working days
  const s1 = computeResponseDue({ raised_on: '2025-06-02', stage: 'stage_1' }, rule);
  const s2 = computeResponseDue({ raised_on: '2025-06-02', stage: 'stage_2' }, rule);
  assert.ok(s2 > s1, 'stage 2 deadline should be later than stage 1');
});

test('computeOmbudsmanDeadline adds the referral window in months', () => {
  const rule = ruleFor('council'); // 12 months
  assert.equal(
    computeOmbudsmanDeadline({ raised_on: '2025-01-15' }, rule),
    '2026-01-15',
  );
});

test('deriveStatus: responded complaint reads as responded', () => {
  const rule = ruleFor('council');
  const d = deriveStatus(
    { state: 'open', stage: 'stage_1', responded_on: '2025-06-10', response_due: '2025-06-20' },
    rule,
  );
  assert.equal(d.status, 'responded');
  assert.equal(d.overdue, false);
});

test('deriveStatus: past due date with no response is overdue', () => {
  const rule = ruleFor('council');
  const d = deriveStatus(
    { state: 'open', stage: 'stage_1', responded_on: null, response_due: '2020-01-01' },
    rule,
  );
  assert.equal(d.status, 'response_overdue');
  assert.equal(d.overdue, true);
});

test('deriveStatus: resolved short-circuits', () => {
  const d = deriveStatus({ state: 'resolved' }, ruleFor('council'));
  assert.equal(d.status, 'resolved');
  assert.equal(d.overdue, false);
});

test('effectiveRule overlays org overrides onto type defaults', () => {
  const rule = effectiveRule(
    { stage1_response_days: 5, ombudsman_name: 'Custom Ombudsman' },
    'council',
  );
  assert.equal(rule.stage1Days, 5); // overridden
  assert.equal(rule.stage2Days, 20); // default retained
  assert.equal(rule.ombudsman, 'Custom Ombudsman');
});
