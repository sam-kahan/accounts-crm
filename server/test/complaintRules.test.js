import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referralOpen,
  procedureOnFile,
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

// --- Procedures followed step by step (migration 019) -----------------------
import {
  addMonths,
  computeAckDue,
  computeOmbudsmanFrom,
  procedureSteps,
  describeChanges,
  theOmbudsman,
  ukDate,
  ombudsmanUrlFor,
} from '../src/services/complaintRules.js';

// LivingCity's PRO39 V7: acknowledge in 3 working days; Stage 1 outcome 15
// working days from SENDING the acknowledgement; Stage 2 15 working days from
// the request; TPO after the final viewpoint or 8 weeks, within 12 months of
// the final viewpoint letter.
const PRO39 = {
  type: 'managing_agent',
  procedure_ref: 'PRO39 V7',
  ack_days: 3,
  stage1_response_days: 15,
  stage1_clock: 'acknowledgement',
  stage2_response_days: 15,
  ombudsman_name: 'The Property Ombudsman',
  ombudsman_referral_months: 12,
  referral_from: 'final_response',
  ombudsman_after_weeks: 8,
};
const complaint = (over = {}) => ({
  state: 'open', stage: 'stage_1', raised_on: '2026-09-28', stage_started_on: '2026-09-28',
  acknowledged_on: null, responded_on: null, final_response_on: null, ...over,
});

test('PRO39: acknowledgement due 3 working days after a Monday complaint', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  assert.equal(computeAckDue(complaint(), rule), '2026-10-01');
});

test('PRO39: Stage 1 counts from the acknowledgement — latest date if none yet', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  assert.equal(computeResponseDue(complaint(), rule), '2026-10-22');
  // Acknowledged a day early → the outcome is due a day earlier too.
  assert.equal(computeResponseDue(complaint({ acknowledged_on: '2026-09-30' }), rule), '2026-10-21');
});

test('a receipt-clock body counts Stage 1 from receipt regardless of acknowledgement', () => {
  const rule = effectiveRule({ ...PRO39, stage1_clock: 'receipt' }, 'managing_agent');
  assert.equal(computeResponseDue(complaint({ acknowledged_on: '2026-10-01' }), rule), '2026-10-19');
});

test('Stage 2 is counted from the Stage 2 request date', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  const c = complaint({ stage: 'stage_2', stage_started_on: '2026-10-26' });
  assert.equal(computeResponseDue(c, rule), '2026-11-16');
  assert.equal(computeAckDue(c, rule), null, 'no acknowledgement step is invented for Stage 2');
});

test('referral window from the final response is undated until it arrives', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  assert.equal(computeOmbudsmanDeadline(complaint(), rule), null);
  assert.equal(
    computeOmbudsmanDeadline(complaint({ final_response_on: '2026-11-10' }), rule),
    '2027-11-10',
  );
});

test('may refer 8 weeks after the complaint, or earlier on a final response', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  assert.equal(computeOmbudsmanFrom(complaint(), rule), '2026-11-23');
  assert.equal(computeOmbudsmanFrom(complaint({ final_response_on: '2026-11-10' }), rule), '2026-11-10');
  assert.equal(computeOmbudsmanFrom(complaint(), ruleFor('council')), null);
});

test('addMonths clamps to the end of a shorter month (never later than the real date)', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonths('2026-11-10', 12), '2027-11-10');
});

test('effectiveRule lists what is a general default, not their procedure', () => {
  const rule = effectiveRule({ ack_days: 3 }, 'council');
  assert.ok(!rule.defaulted.includes('ackDays'));
  assert.ok(rule.defaulted.includes('stage1Days'));
  assert.deepEqual(effectiveRule(null, 'council').defaulted.includes('ackDays'), true);
});

test('deriveStatus: unacknowledged past the deadline needs chasing', () => {
  const rule = effectiveRule({ ...PRO39, stage1_response_days: 400 }, 'managing_agent');
  const c = complaint({ raised_on: '2020-01-06', stage_started_on: '2020-01-06', response_due: '2099-01-01' });
  const d = deriveStatus(c, rule);
  assert.equal(d.status, 'ack_overdue');
  assert.equal(d.needs_chasing, true);
  assert.equal(d.overdue, false, 'the response itself is not overdue');
  assert.match(d.nextAction, /PRO39 V7/);
});

test('deriveStatus: a timescale that is only a default says so', () => {
  const c = complaint({ raised_on: '2020-01-06', stage_started_on: '2020-01-06', response_due: '2099-01-01' });
  // Researched, and it states no acknowledgement time: "doesn't set one".
  const d = deriveStatus(c, effectiveRule({ research_status: 'researched' }, 'council'));
  assert.equal(d.status, 'ack_overdue');
  assert.match(d.nextAction, /the standard for a council \(their procedure doesn't set one\)/);
  // Nobody has looked: never claimed that their procedure doesn't set one.
  const u = deriveStatus(c, effectiveRule(null, 'council'));
  assert.match(u.nextAction, /the standard for a council \(their own procedure hasn't been researched yet\)/);
  assert.doesNotMatch(u.nextAction, /doesn't set one/);
});

test('deriveStatus: with the ombudsman is not chased as overdue', () => {
  const d = deriveStatus(complaint({ stage: 'ombudsman', response_due: '2020-01-01' }), ruleFor('council'));
  assert.equal(d.status, 'with_ombudsman');
  assert.equal(d.needs_chasing, false);
});

test('procedureSteps: the PRO39 checklist on the day of the complaint', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  const c = complaint({ response_due: '2026-10-22' });
  const steps = procedureSteps(c, rule);
  const by = Object.fromEntries(steps.map((s) => [s.key, s]));
  assert.deepEqual(steps.map((s) => s.key), ['raised', 'ack', 'stage1', 'stage2', 'ombudsman_from', 'ombudsman_by']);
  assert.equal(by.ack.date, '2026-10-01');
  assert.equal(by.stage1.date, '2026-10-22');
  assert.equal(by.ombudsman_from.date, '2026-11-23');
  assert.equal(by.ombudsman_by.date, null);
  assert.equal(by.ombudsman_by.state, 'pending');
});

test('procedureSteps: acknowledgement recorded is done; skipped past Stage 1 is missed', () => {
  const rule = effectiveRule(PRO39, 'managing_agent');
  const acked = procedureSteps(complaint({ acknowledged_on: '2026-09-30' }), rule);
  assert.equal(acked.find((s) => s.key === 'ack').state, 'done');
  const s2 = procedureSteps(complaint({ stage: 'stage_2', stage_started_on: '2026-10-26' }), rule);
  assert.equal(s2.find((s) => s.key === 'ack').state, 'missed');
});

test('describeChanges lists each corrected field with old and new values', () => {
  const out = describeChanges(
    { acknowledged_on: '2026-09-30', reference: null, description: 'a' },
    { acknowledged_on: '2026-09-29', reference: 'X1', description: 'b' },
  );
  assert.deepEqual(out, [
    'their reference: (blank) → X1',
    'details edited',
    'acknowledged: Wed 30 Sep 2026 → Tue 29 Sep 2026',
  ]);
  assert.deepEqual(describeChanges({ subject: 's' }, { subject: 's' }), []);
});

test('theOmbudsman never doubles "the"', () => {
  assert.equal(theOmbudsman('The Property Ombudsman'), 'The Property Ombudsman');
  assert.equal(theOmbudsman('Housing Ombudsman'), 'the Housing Ombudsman');
});

test('ukDate reads as people write it', () => {
  assert.equal(ukDate('2026-10-01'), 'Thu 1 Oct 2026');
  assert.equal(ukDate('2026-09-25'), 'Fri 25 Sep 2026');
});

test('ombudsmanUrlFor knows the schemes by name or initials', () => {
  assert.equal(ombudsmanUrlFor('The Property Ombudsman'), 'https://www.tpos.co.uk/');
  assert.equal(ombudsmanUrlFor('TPO'), 'https://www.tpos.co.uk/');
  assert.equal(ombudsmanUrlFor('Property Redress Scheme'), 'https://www.theprs.co.uk/');
  assert.equal(ombudsmanUrlFor('Housing Ombudsman Service'), 'https://www.housing-ombudsman.org.uk/');
  assert.equal(ombudsmanUrlFor('Local Government & Social Care Ombudsman'), 'https://www.lgo.org.uk/');
  assert.equal(ombudsmanUrlFor('Some Other Scheme'), null);
  assert.equal(ombudsmanUrlFor(null), null);
});

test('a named scheme with no website gets its own, never the type default', () => {
  const tpo = effectiveRule({ ombudsman_name: 'The Property Ombudsman' }, 'council');
  assert.equal(tpo.ombudsmanUrl, 'https://www.tpos.co.uk/');
  const unknown = effectiveRule({ ombudsman_name: 'Some Other Scheme' }, 'council');
  assert.equal(unknown.ombudsmanUrl, '', 'not the LGSCO default');
});

test('a debt collector: final response within 8 calendar WEEKS (FCA), then 6 months to the FOS', async () => {
  const { effectiveRule, computeResponseDue, computeOmbudsmanDeadline, computeOmbudsmanFrom } = await import('../src/services/complaintRules.js');
  const rule = effectiveRule(null, 'debt_collector');
  const c = { stage: 'stage_1', raised_on: '2026-12-01', stage_started_on: '2026-12-01' };
  // 8 weeks, straight through Christmas: never pushed later by bank holidays
  assert.equal(computeResponseDue(c, rule), '2027-01-26');
  assert.equal(computeOmbudsmanFrom(c, rule), '2027-01-26');
  assert.equal(computeOmbudsmanDeadline(c, rule), null); // counted from their final response
  assert.equal(computeOmbudsmanDeadline({ ...c, final_response_on: '2027-01-20' }, rule), '2027-07-20');
  assert.match(rule.ombudsman, /Financial Ombudsman/);
  // their own procedure's figure in working days replaces the weeks
  const theirs = effectiveRule({ type: 'debt_collector', stage1_response_days: 15 }, 'debt_collector');
  assert.equal(theirs.stage1Weeks, null);
});

test('a standard figure filled in on the form never replaces the standard rule (a collector keeps 8 calendar weeks)', () => {
  const org = {
    type: 'debt_collector', stage1_response_days: 40,
    procedure_sources: { stage1_response_days: 'standard' },
  };
  const rule = effectiveRule(org, 'debt_collector');
  assert.equal(rule.stage1Weeks, 8);
  assert.ok(rule.defaulted.includes('stage1Days'));
  // Their own stated figure still replaces it.
  const own = effectiveRule({ ...org, procedure_sources: { stage1_response_days: 'document' } }, 'debt_collector');
  assert.equal(own.stage1Weeks, null);
  assert.equal(own.stage1Days, 40);
});

test('procedureOnFile: only an organisation whose own procedure has been found out', () => {
  assert.equal(procedureOnFile(null), false); // not linked to a saved organisation
  assert.equal(procedureOnFile({ research_status: 'none' }), false); // set up by an import, name only
  assert.equal(procedureOnFile({ research_status: 'researched' }), true);
  assert.equal(procedureOnFile({ research_status: 'document' }), true);
  assert.equal(procedureOnFile({ research_status: 'manual' }), true);
  assert.equal(procedureOnFile({ research_status: 'none', verified_at: '2026-09-01T10:00:00Z' }), true); // a person checked it
});

test('deriveStatus: waiting on them with the ombudsman already open says wait first, never only "you can also refer"', () => {
  const c = complaint({ stage: 'stage_2', raised_on: '2020-01-06', stage_started_on: '2099-01-01', response_due: '2099-02-01', acknowledged_on: '2020-01-07' });
  const d = deriveStatus(c, effectiveRule(null, 'energy'));
  assert.equal(d.status, 'awaiting_response');
  assert.match(d.nextAction, /^Nothing to send yet: wait for their final \(Stage 2\) response, due /);
  assert.match(d.nextAction, /If you'd rather not wait, you can already refer it to the Energy Ombudsman \(8 weeks have passed since the complaint was made on Mon 6 Jan 2020\)\.$/);
  // Imported and not yet checked: never "you can refer", only "don't yet".
  const u = deriveStatus({ ...c, needs_check: true }, effectiveRule(null, 'energy'));
  assert.doesNotMatch(u.nextAction, /can already refer|You can also refer/);
  assert.match(u.nextAction, /Don’t refer it to the Energy Ombudsman yet: this imported complaint hasn’t been checked: confirm the date it was made \(recorded as Mon 6 Jan 2020\)/);
  assert.doesNotMatch(d.nextAction, /^You can also/);
});

test('referralOpen: never too early for the ombudsman', () => {
  const energy = effectiveRule(null, 'energy');
  const base = { stage: 'stage_1', raised_on: '2026-08-09', rule: energy };
  // Energy: 8 weeks from the complaint. Made 9 Aug: not until Sun 4 Oct.
  const early = referralOpen({ ...base, ombudsman_from: computeOmbudsmanFrom(base, energy) }, '2026-09-29');
  assert.equal(early.open, false);
  assert.equal(early.from, '2026-10-04');
  assert.match(early.why, /can’t take it until Sun 4 Oct 2026 \(8 weeks after the complaint was made on Sun 9 Aug 2026\)/);
  assert.equal(referralOpen({ ...base, ombudsman_from: '2026-10-04' }, '2026-10-04').open, true);
  // The dates say yes, but nobody has checked the import, or there is a question: no.
  assert.equal(referralOpen({ ...base, ombudsman_from: '2026-10-04', needs_check: true }, '2026-11-01').open, false);
  assert.equal(referralOpen({ ...base, ombudsman_from: '2026-10-04', complaint_doubt: { kind: 'raised_date', date: '2026-09-01' } }, '2026-11-01').open, false);
  assert.equal(referralOpen({ ...base, ombudsman_from: '2026-10-04', complaint_doubt: { kind: 'raised_date', answered: true } }, '2026-11-01').open, true);
  // A final response opens it from that day.
  assert.equal(referralOpen({ ...base, stage: 'stage_2', final_response_on: '2026-09-20', ombudsman_from: '2026-09-20' }, '2026-09-29').open, true);
  // No wait set by the scheme: only once their procedure has run out (Stage 2 missed).
  const council = { stage: 'stage_2', raised_on: '2026-06-01', rule: effectiveRule(null, 'council'), ombudsman_from: null };
  assert.equal(referralOpen({ ...council, response_due: '2026-09-30' }, '2026-09-29').open, false);
  assert.equal(referralOpen({ ...council, response_due: '2026-09-20' }, '2026-09-29').open, true);
  assert.equal(referralOpen({ ...council, stage: 'stage_1', response_due: '2026-09-20' }, '2026-09-29').open, false);
});
