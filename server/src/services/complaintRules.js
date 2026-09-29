// ---------------------------------------------------------------------------
// Complaint deadline rules engine.
//
// Encodes indicative complaint-handling timescales and escalation routes per
// organisation type, computes working-day deadlines (England & Wales bank
// holidays included), and derives each complaint's status + next legal step.
//
// These are sensible DEFAULTS with their legal basis noted — every date is
// overridable per organisation (via research) and per complaint. They are not
// legal advice; verify against the specific body's published procedure.
// ---------------------------------------------------------------------------

// England & Wales bank holidays 2025–2028 (YYYY-MM-DD). Extend as needed.
const BANK_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26',
  '2025-08-25', '2025-12-25', '2025-12-26',
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25',
  '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31',
  '2027-08-30', '2027-12-27', '2027-12-28',
  // 2028
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29',
  '2028-08-28', '2028-12-25', '2028-12-26',
]);

import { todayISO } from '../lib/dates.js';

const iso = (d) => d.toISOString().slice(0, 10);

function isWorkingDay(d) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // Sun/Sat
  return !BANK_HOLIDAYS.has(iso(d));
}

// Add N working days to a YYYY-MM-DD date string (skips weekends + bank hols).
export function addWorkingDays(dateStr, n) {
  if (!dateStr || !n) return dateStr || null;
  const d = new Date(dateStr + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d)) added += 1;
  }
  return iso(d);
}

// Working days between today and a due date (negative = overdue).
export function workingDaysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayISO() + 'T00:00:00Z');
  const target = new Date(dateStr + 'T00:00:00Z');
  if (iso(target) === iso(today)) return 0;
  const forward = target > today;
  let count = 0;
  const cur = new Date(today);
  while (iso(cur) !== iso(target)) {
    cur.setUTCDate(cur.getUTCDate() + (forward ? 1 : -1));
    if (isWorkingDay(cur)) count += forward ? 1 : -1;
  }
  return count;
}

// Add calendar months, clamping to the last day of a shorter month: 31 Jan +
// 1 month is 28 Feb, not 3 Mar. Letting it overflow would state a referral
// deadline later than the real one — the one direction that must never happen.
export function addMonths(dateStr, months) {
  if (!dateStr || !months) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(ty, tm, Math.min(d, last))));
}

function addCalendarDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

// Default rules by organisation type. Editable per organisation via research.
export const RULES = {
  council: {
    label: 'Local council',
    stage1Days: 10,
    stage2Days: 20,
    ackDays: 3,
    ombudsman: 'Local Government & Social Care Ombudsman (LGSCO)',
    ombudsmanUrl: 'https://www.lgo.org.uk/',
    referralMonths: 12,
    legalBasis:
      'Council complaint timescales vary by authority (commonly ~10 working days at Stage 1, ~20 at Stage 2). The LGSCO can investigate once the council’s process is exhausted; normally refer within 12 months of becoming aware of the problem.',
  },
  housing_association: {
    label: 'Housing association / social landlord',
    stage1Days: 10,
    stage2Days: 20,
    ackDays: 5,
    ombudsman: 'Housing Ombudsman',
    ombudsmanUrl: 'https://www.housing-ombudsman.org.uk/',
    referralMonths: 12,
    legalBasis:
      'Housing Ombudsman Complaint Handling Code (statutory from 1 Apr 2024): acknowledge within 5 working days; Stage 1 response within 10 working days; Stage 2 within 20 working days.',
  },
  water: {
    label: 'Water supplier',
    stage1Days: 10,
    stage2Days: 10,
    ackDays: 5,
    ombudsman: 'Consumer Council for Water (CCW), then WATRS adjudication',
    ombudsmanUrl: 'https://www.ccw.org.uk/',
    referralMonths: 12,
    legalBasis:
      'Water companies should respond within 10 working days. If unresolved, escalate to CCW; binding adjudication is available via WATRS.',
  },
  energy: {
    label: 'Energy supplier',
    stage1Days: 10,
    stage2Days: 10,
    ackDays: 5,
    ombudsman: 'Energy Ombudsman',
    ombudsmanUrl: 'https://www.energyombudsman.org/',
    referralMonths: 12,
    ombudsmanAfterWeeks: 8,
    legalBasis:
      'Complain to the supplier first. You can take it to the Energy Ombudsman after 8 weeks without resolution, or on receipt of a deadlock letter.',
  },
  supplier: {
    label: 'Supplier / contractor',
    stage1Days: 10,
    stage2Days: 20,
    ackDays: 5,
    ombudsman: 'Relevant ADR scheme / Trading Standards',
    ombudsmanUrl: '',
    referralMonths: 12,
    legalBasis:
      'No single statutory timescale; a reasonable response is around 10 working days. Check whether the supplier belongs to an ADR/ombudsman scheme; consider Trading Standards if ignored.',
  },
  managing_agent: {
    label: 'Managing agent / freeholder',
    stage1Days: 15,
    stage2Days: 15,
    ackDays: 3,
    ombudsman: 'The Property Ombudsman (TPO) or the Property Redress Scheme, whichever the agent belongs to',
    ombudsmanUrl: 'https://www.tpos.co.uk/',
    referralMonths: 12,
    referralFrom: 'final_response',
    ombudsmanAfterWeeks: 8,
    legalBasis:
      'Residential managing agents in England must belong to a government-approved redress scheme (The Property Ombudsman or the Property Redress Scheme). The schemes expect an acknowledgement within about 3 working days and a written outcome within about 15; you can refer once the agent’s own process is finished or 8 weeks have passed since the complaint was made, and within 12 months of their final response. Whether a service charge or administration charge is payable or reasonable is for the First-tier Tribunal (Property Chamber). Check these against the agent’s own procedure.',
  },
  debt_collector: {
    label: 'Debt collector',
    ackDays: 5,
    // The FCA's rule is a final response within 8 WEEKS (calendar), not a
    // number of working days: counted as weeks so a bank holiday can never
    // push the date later than the real one.
    stage1Days: 40,
    stage1Weeks: 8,
    stage2Days: 20,
    ombudsman: 'Financial Ombudsman Service',
    ombudsmanUrl: 'https://www.financial-ombudsman.org.uk/',
    referralMonths: 6,
    referralFrom: 'final_response',
    ombudsmanAfterWeeks: 8,
    legalBasis:
      'Debt collection is regulated by the Financial Conduct Authority. Under its complaint rules (DISP) the firm must acknowledge a complaint promptly and send a final response within 8 weeks; you can then take it to the Financial Ombudsman Service, which normally needs it within 6 months of their final response, or once 8 weeks have passed with no final response. Check the collector is FCA-authorised (the FCA register). The debt itself is the SUPPLIER’s: raise it with them too, and ask them to hold or recall the account from collection while it is disputed.',
  },
  other: {
    label: 'Other',
    stage1Days: 10,
    stage2Days: 20,
    ackDays: 5,
    ombudsman: 'Relevant ombudsman / ADR scheme',
    ombudsmanUrl: '',
    referralMonths: 12,
    legalBasis: 'Timescales are indicative; adjust to the specific body’s procedure.',
  },
};

// "the Housing Ombudsman", but "The Property Ombudsman" — never "the The …".
export function theOmbudsman(name) {
  const n = String(name || 'ombudsman');
  return /^the\s/i.test(n) ? n : `the ${n}`;
}

// The UK ombudsman / redress schemes the team deals with, so the website is
// known from the name rather than typed in each time. Matched on the name as
// people write it (full name or initials). First match wins.
const KNOWN_OMBUDSMEN = [
  [/property ombudsman|\bTPOS?\b/i, 'https://www.tpos.co.uk/'],
  [/property redress|\bPRS\b/i, 'https://www.theprs.co.uk/'],
  [/housing ombudsman/i, 'https://www.housing-ombudsman.org.uk/'],
  [/local government|\bLGSCO\b|\bLGO\b/i, 'https://www.lgo.org.uk/'],
  [/energy ombudsman/i, 'https://www.energyombudsman.org/'],
  [/consumer council for water|\bCCW\b/i, 'https://www.ccw.org.uk/'],
  [/\bWATRS\b|water redress/i, 'https://www.watrs.org/'],
  [/financial ombudsman/i, 'https://www.financial-ombudsman.org.uk/'],
  [/parliamentary and health|\bPHSO\b/i, 'https://www.ombudsman.org.uk/'],
  [/ombudsman (for )?wales|public services ombudsman/i, 'https://www.ombudsman.wales/'],
];

export function ombudsmanUrlFor(name) {
  if (!name) return null;
  const hit = KNOWN_OMBUDSMEN.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

export function ruleFor(type) {
  return RULES[type] || RULES.other;
}

// The procedure values an organisation record can state, keyed to the rule
// field each one fills. A NULL on the organisation means "not stated for this
// body", and the type default applies — `defaulted` lists which, so the screen
// can say the figure is a general default rather than their procedure.
const ORG_FIELDS = {
  ackDays: 'ack_days',
  stage1Days: 'stage1_response_days',
  stage2Days: 'stage2_response_days',
  stage1Clock: 'stage1_clock',
  ombudsman: 'ombudsman_name',
  ombudsmanUrl: 'ombudsman_url',
  referralMonths: 'ombudsman_referral_months',
  referralFrom: 'referral_from',
  ombudsmanAfterWeeks: 'ombudsman_after_weeks',
  legalBasis: 'legal_basis',
};

// Merge an organisation's researched/edited overrides onto the type defaults.
// How each type reads in a sentence ("the standard for an energy supplier").
const KIND_PHRASE = {
  council: 'a council', housing_association: 'a housing association', water: 'a water company',
  energy: 'an energy supplier', supplier: 'a supplier', managing_agent: 'a managing agent',
  debt_collector: 'a debt collector (the FCA’s rules)',
  other: 'this kind of organisation',
};

export function effectiveRule(org, type) {
  const base = {
    stage1Clock: 'receipt',
    referralFrom: 'raised',
    ombudsmanAfterWeeks: null,
    ...ruleFor(type || org?.type),
  };
  const rule = {
    ...base, procedureRef: null, defaulted: Object.keys(ORG_FIELDS), kind: KIND_PHRASE[type || org?.type] || KIND_PHRASE.other,
    // Nobody has found out their procedure, so a default can't be said to
    // be because "their procedure doesn't set one" (basisOf).
    unresearched: !procedureOnFile(org),
  };
  if (!org) return rule;
  const defaulted = [];
  for (const [key, col] of Object.entries(ORG_FIELDS)) {
    const v = org[col];
    // A figure marked 'standard' was only filled in to show the standard
    // (their procedure gives none), so the standard itself applies, exactly
    // as for a blank: a debt collector's 8 calendar weeks stays 8 weeks,
    // never becomes "40 working days" (a later date) because the form was
    // saved.
    if (v === null || v === undefined || v === '' || org.procedure_sources?.[col] === 'standard') defaulted.push(key);
    else rule[key] = v;
  }
  rule.defaulted = defaulted;
  // Their own Stage 1 timescale (in working days) replaces a default counted
  // in weeks.
  if (!defaulted.includes('stage1Days')) rule.stage1Weeks = null;
  // Where each figure came from: their document, research of their website,
  // or typed in (migration 027).
  rule.sourceOf = {};
  for (const [key, col] of Object.entries(ORG_FIELDS)) {
    if (org.procedure_sources?.[col]) rule.sourceOf[key] = org.procedure_sources[col];
    // A standard figure filled in because they publish none is still the
    // standard, and is said to be (not passed off as their own).
    if (org.procedure_sources?.[col] === 'standard' && !rule.defaulted.includes(key)) rule.defaulted.push(key);
  }
  // A named scheme with no website typed: use the known one for that name —
  // never the type default's, which would point at a different scheme.
  if (org.ombudsman_name && !org.ombudsman_url) {
    rule.ombudsmanUrl = ombudsmanUrlFor(org.ombudsman_name) || '';
    rule.defaulted = defaulted.filter((k) => k !== 'ombudsmanUrl');
  }
  rule.procedureRef = org.procedure_ref || null;
  return rule;
}

// Has anyone found out this organisation's own complaints procedure? Yes when
// their website was researched, their document read, figures typed in, or a
// person has checked it. No when the complaint isn't linked to a saved
// organisation, or the organisation was only set up (an import makes one with
// nothing but a name, and research that fails leaves it the same): its dates
// are then the standard ones for its type, not their rules, so the complaint
// is flagged until it is researched.
export function procedureOnFile(org) {
  if (!org) return false;
  if (org.verified_at) return true;
  return ['researched', 'document', 'manual'].includes(org.research_status);
}

const stageStart = (c) => c.stage_started_on || c.raised_on;

// Is this organisation's track still running? A complaint with more than one
// organisation stays open while any of them is, so the main organisation's
// own track can have ended (its stage says 'resolved' or 'closed') while the
// complaint's state is still 'open'. Every track — the complaint row or a
// complaint_parties row — is read the same way.
export function trackOpen(t) {
  return (t?.state || 'open') === 'open' && !['resolved', 'closed'].includes(t?.stage);
}

// A value for a sentence: an ISO date as ukDate, anything else unchanged.
export function readable(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? ukDate(v) : v;
}

// A date as people read it in a sentence: "Thu 1 Oct 2026".
export function ukDate(iso) {
  if (!iso) return iso;
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    })
    .replace(',', '')
    .replace('Sept', 'Sep');
}

// Where a timescale comes from, said honestly: their named procedure, or the
// general default for this kind of body when their own hasn't been confirmed.
function basisOf(rule, key) {
  if (rule.defaulted?.includes(key)) {
    return rule.unresearched
      ? `the standard for ${rule.kind || 'this kind of organisation'} (their own procedure hasn't been researched yet)`
      : `the standard for ${rule.kind || 'this kind of organisation'} (their procedure doesn't set one)`;
  }
  if (rule.sourceOf?.[key] === 'research') return 'their published complaints information (researched)';
  return rule.procedureRef || 'their procedure';
}

// When the organisation should have acknowledged the complaint. Only Stage 1
// carries an acknowledgement step — most procedures (LivingCity's PRO39, for
// one) state none for Stage 2, and inventing one would chase a deadline that
// doesn't exist.
export function computeAckDue(complaint, rule) {
  if ((complaint.stage || 'stage_1') !== 'stage_1' || !rule.ackDays) return null;
  return addWorkingDays(stageStart(complaint), rule.ackDays);
}

// The response-due date for the complaint's current stage. Some procedures
// start the Stage 1 clock from the day they ACKNOWLEDGE rather than the day
// they receive it ("15 working days of sending the acknowledgement"); until
// they do, the date assumes an acknowledgement on the last permitted day,
// which is the latest the outcome can properly arrive.
export function computeResponseDue(complaint, rule) {
  const stage = complaint.stage || 'stage_1';
  const start = stageStart(complaint);
  if (stage === 'stage_1') {
    if (rule.stage1Weeks) return addCalendarDays(start, rule.stage1Weeks * 7);
    if (rule.stage1Clock === 'acknowledgement') {
      const from = complaint.acknowledged_on || computeAckDue(complaint, rule);
      return addWorkingDays(from, rule.stage1Days);
    }
    return addWorkingDays(start, rule.stage1Days);
  }
  if (stage === 'stage_2') return addWorkingDays(start, rule.stage2Days);
  return null;
}

// The last day to refer to the ombudsman. Counted from the complaint being
// raised unless the body's window runs from its final response, in which case
// there is no date until that response arrives — a guess would be a deadline
// nobody could rely on.
export function computeOmbudsmanDeadline(complaint, rule) {
  if (rule.referralFrom === 'final_response') {
    return complaint.final_response_on
      ? addMonths(complaint.final_response_on, rule.referralMonths)
      : null;
  }
  return addMonths(complaint.raised_on, rule.referralMonths);
}

// The first day a referral is allowed: their final response, or N weeks after
// the complaint was made if the scheme lets you go early — whichever is first.
export function computeOmbudsmanFrom(complaint, rule) {
  const early = rule.ombudsmanAfterWeeks
    ? addCalendarDays(complaint.raised_on, rule.ombudsmanAfterWeeks * 7)
    : null;
  const dates = [early, complaint.final_response_on].filter(Boolean).sort();
  return dates[0] || null;
}

const plural = (n, word) => `${n} working day${n === 1 ? '' : 's'}${word ? ` ${word}` : ''}`;

// Derive live status + a plain-English "next action" for a complaint.
export function deriveStatus(complaint, rule) {
  const base = { overdue: false, ack_overdue: false, needs_chasing: false };
  if (complaint.state === 'resolved' || complaint.stage === 'resolved')
    return { ...base, status: 'resolved', label: 'Resolved', nextAction: null };
  if (complaint.state === 'closed' || complaint.stage === 'closed')
    return { ...base, status: 'closed', label: 'Closed', nextAction: null };
  if (complaint.stage === 'ombudsman')
    return {
      ...base,
      status: 'with_ombudsman',
      label: 'With the ombudsman',
      nextAction: `Referred to ${theOmbudsman(rule.ombudsman)}. Log their correspondence here as it arrives.`,
    };

  const today = todayISO();
  const responded = Boolean(complaint.responded_on);
  const due = complaint.response_due;
  const wd = due ? workingDaysUntil(due) : null;
  const overdue = !responded && wd !== null && wd < 0;
  const ackDue = computeAckDue(complaint, rule);
  const ackWd = ackDue && !complaint.acknowledged_on ? workingDaysUntil(ackDue) : null;
  const ackOverdue = !responded && ackWd !== null && ackWd < 0;
  const referFrom = computeOmbudsmanFrom(complaint, rule);
  const canReferNow = referFrom && referFrom <= today;
  // Why a referral is open, with the date it rests on, so a wrong date (an
  // import that took an early email for the complaint) is visible rather
  // than a bare "you can refer" — and on a complaint nobody has checked yet,
  // a prompt to check that date first.
  const referWhy = !canReferNow ? ''
    : complaint.final_response_on && complaint.final_response_on === referFrom
      ? `their final response was on ${ukDate(complaint.final_response_on)}`
      : `${rule.ombudsmanAfterWeeks} week${rule.ombudsmanAfterWeeks === 1 ? ' has' : 's have'} passed since the complaint was made on ${ukDate(complaint.raised_on)}` +
        (complaint.needs_check ? '; check that date first, as this complaint hasn’t been checked yet' : '');
  const referNote = canReferNow
    ? ` You can also refer it to ${theOmbudsman(rule.ombudsman)} now (${referWhy}).`
    : '';

  if (responded) {
    let nextAction = null;
    if (complaint.stage === 'stage_1') {
      nextAction =
        'Stage 1 response received. If it doesn’t resolve things, ask for Stage 2 in writing, ' +
        'setting out each point you want reviewed and why.' + referNote;
    } else if (complaint.stage === 'stage_2') {
      nextAction = `Final response received. If still unresolved, you can refer to ${theOmbudsman(rule.ombudsman)}.`;
    }
    return { ...base, status: 'responded', label: 'Response received', nextAction };
  }

  if (overdue) {
    const nextAction =
      complaint.stage === 'stage_1'
        ? `No Stage 1 outcome by ${ukDate(due)} (${basisOf(rule, 'stage1Days')}). Chase in writing; missing the ` +
          'deadline is itself a complaint-handling failure, and you can ask for Stage 2.' + referNote
        : `No Stage 2 response by ${ukDate(due)} (${basisOf(rule, 'stage2Days')}). You can refer ` +
          `the complaint to ${theOmbudsman(rule.ombudsman)}, citing their failure to respond.`;
    return {
      ...base,
      status: 'response_overdue',
      label: `No response, ${plural(Math.abs(wd), 'overdue')}`,
      nextAction,
      overdue: true,
      ack_overdue: ackOverdue,
      needs_chasing: true,
    };
  }

  if (ackOverdue) {
    return {
      ...base,
      status: 'ack_overdue',
      label: `Not acknowledged, ${plural(Math.abs(ackWd), 'overdue')}`,
      nextAction:
        `They should have acknowledged it by ${ukDate(ackDue)} (${rule.ackDays} working days, ` +
        `${basisOf(rule, 'ackDays')}). Chase for an acknowledgement; the Stage 1 outcome is still ` +
        `due by ${due ? ukDate(due) : 'the date shown'}.`,
      ack_overdue: true,
      needs_chasing: true,
    };
  }

  if (ackWd !== null) {
    return {
      ...base,
      status: 'awaiting_ack',
      label: `Awaiting acknowledgement, due in ${plural(ackWd)}`,
      // Always a step, even when it is only to wait: a blank tells nobody
      // whether anything is needed.
      nextAction: `Nothing to send yet: wait for their acknowledgement, due ${ukDate(ackDue)}.`,
    };
  }
  const label =
    wd !== null ? `Awaiting response, due in ${plural(wd)}` : 'Awaiting response';
  const waitFor = `their ${complaint.stage === 'stage_2' ? 'final (Stage 2)' : 'Stage 1'} response`;
  return {
    ...base,
    status: 'awaiting_response',
    label,
    // The wait comes first, always: the referral note on its own ("You can
    // also refer it…") read as the only step, next to a review saying wait.
    nextAction: (due ? `Nothing to send yet: wait for ${waitFor}, due ${ukDate(due)}.` : `Wait for ${waitFor}.`) +
      (canReferNow ? ` If you'd rather not wait, you can already refer it to ${theOmbudsman(rule.ombudsman)} (${referWhy}).` : ''),
  };
}

// The complaint's procedure as a checklist: every step their procedure sets,
// with the date it falls on and where it stands. Pure, so the screen, the AI
// assistant and the tests all read the same answer.
//   state: done | overdue | due | upcoming | available | missed | past | pending
export function procedureSteps(complaint, rule) {
  const today = todayISO();
  const stage = complaint.stage || 'stage_1';
  const closed = !trackOpen(complaint);
  const order = { stage_1: 1, stage_2: 2, ombudsman: 3, resolved: 4, closed: 4 };
  const at = order[stage] || 1;
  const timed = (date, done) =>
    done ? 'done' : closed ? 'past' : !date ? 'pending' : date < today ? 'overdue' : 'due';

  const steps = [];
  steps.push({
    key: 'raised', label: 'Complaint made', date: complaint.raised_on, state: 'done',
    note: complaint.channel ? `By ${complaint.channel}` : null,
  });

  const ackDue = at === 1 ? computeAckDue(complaint, rule) : null;
  let ackState;
  if (complaint.acknowledged_on) ackState = 'done';
  else if (at > 1) ackState = 'missed';
  else if (closed || complaint.responded_on) ackState = 'past'; // a response supersedes it
  else ackState = timed(ackDue, false);
  steps.push({
    key: 'ack',
    label: 'Acknowledgement due',
    date: complaint.acknowledged_on || ackDue,
    state: ackState,
    note: complaint.acknowledged_on
      ? `Acknowledged ${ukDate(complaint.acknowledged_on)}`
      : `${rule.ackDays} working days from receipt (${basisOf(rule, 'ackDays')})`,
  });

  const s1Note = rule.stage1Weeks
    ? `${rule.stage1Weeks} weeks from receipt`
    : rule.stage1Clock === 'acknowledgement'
      ? `${rule.stage1Days} working days from their acknowledgement` +
        (complaint.acknowledged_on ? '' : '. This is the latest date, if they acknowledge on time')
      : `${rule.stage1Days} working days from receipt`;
  steps.push(
    at === 1
      ? {
          key: 'stage1', label: 'Stage 1 outcome due', date: complaint.response_due,
          state: timed(complaint.response_due, Boolean(complaint.responded_on)),
          note: complaint.responded_on
            ? `Responded ${ukDate(complaint.responded_on)}`
            : `${s1Note} (${basisOf(rule, 'stage1Days')})`,
        }
      : { key: 'stage1', label: 'Stage 1', date: null, state: 'past', note: 'Stage 1 finished' },
  );

  if (at <= 1) {
    steps.push({
      key: 'stage2', label: 'Stage 2 final response', date: null,
      state: closed ? 'past' : 'upcoming',
      note: `If needed: ask for Stage 2 in writing and they then have ${rule.stage2Days} working days`,
    });
  } else if (at === 2) {
    steps.push({
      key: 'stage2', label: 'Stage 2 final response due', date: complaint.response_due,
      state: timed(complaint.response_due, Boolean(complaint.responded_on)),
      note: complaint.responded_on
        ? `Final response ${ukDate(complaint.responded_on)}`
        : `${rule.stage2Days} working days from the Stage 2 request on ${ukDate(complaint.stage_started_on || complaint.raised_on)} (${basisOf(rule, 'stage2Days')})`,
    });
  } else {
    steps.push({
      key: 'stage2', label: 'Stage 2 final response', date: complaint.final_response_on || null,
      state: complaint.final_response_on ? 'done' : 'past', note: null,
    });
  }

  const from = computeOmbudsmanFrom(complaint, rule);
  const earlyNote = rule.ombudsmanAfterWeeks
    ? `After their final response, or ${rule.ombudsmanAfterWeeks} weeks after the complaint was made`
    : 'Once their final response has been received';
  steps.push({
    key: 'ombudsman_from', label: `Can refer to the ombudsman`,
    date: from,
    state: at >= 3 ? 'done' : closed ? 'past' : !from ? 'pending' : from <= today ? 'available' : 'upcoming',
    note: at >= 3 ? `Referred to ${theOmbudsman(rule.ombudsman)}` : earlyNote,
  });

  const by = complaint.ombudsman_deadline || null;
  steps.push({
    key: 'ombudsman_by', label: 'Refer by', date: by,
    state: at >= 3 ? 'done' : closed ? 'past' : !by ? 'pending' : by < today ? 'overdue' : 'upcoming',
    note:
      rule.referralFrom === 'final_response'
        ? `${rule.referralMonths} months from their final response` +
          (complaint.final_response_on ? '' : ', dated once it arrives')
        : `${rule.referralMonths} months from when the complaint was made`,
  });
  return steps;
}

// A correction to a complaint, as a list of plain-English changes for the
// timeline. Plain-English labels for the fields a correction can touch.
const FIELD_LABEL = {
  organisation_id: 'organisation', org_name: 'organisation name', org_type: 'type',
  reference: 'their reference', our_reference: 'our reference', account_numbers: 'account number', property: 'property',
  subject: 'subject', category: 'category', description: 'details', channel: 'channel',
  raised_on: 'date raised', stage_started_on: 'stage started', acknowledged_on: 'acknowledged',
  responded_on: 'responded', final_response_on: 'final response', response_due: 'response due',
  ombudsman_deadline: 'refer-by date',
};
export function describeChanges(before, after) {
  const out = [];
  for (const [col, label] of Object.entries(FIELD_LABEL)) {
    const flat = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : null) : v ?? null);
    const a = flat(before[col]);
    const b = flat(after[col]);
    if (a === b) continue;
    if (col === 'description') out.push('details edited');
    else if (col === 'organisation_id') out.push(b ? 'linked to a saved organisation' : 'organisation link removed');
    else if (col === 'org_type') out.push(`type: ${ruleFor(a).label} → ${ruleFor(b).label}`);
    else out.push(`${label}: ${readable(a) ?? '(blank)'} → ${readable(b) ?? '(blank)'}`);
  }
  return out;
}

// What an AI review was written against. When this changes, the review is out
// of date (the nightly job and the page both use it).
// Each further organisation's track counts too (appended only when there is
// one, so a complaint with a single organisation keeps the signature its
// stored review was written against).
export function reviewSignature(c) {
  const one = (t) => [t.status, t.stage, t.state, t.acknowledged_on, t.responded_on, t.final_response_on,
    t.response_due].map((v) => v ?? '').join('|');
  return [one(c), ...(c.parties || []).map((p) => `${p.id}:${one(p)}`)].join('||');
}

// The one-click actions a review may recommend, each mapped to a button that
// opens the same confirmation as doing it by hand.
export const REVIEW_ACTIONS = [
  'send_email', 'escalate_stage2', 'refer_ombudsman', 'record_acknowledgement',
  'record_response', 'resolve', 'wait',
];
export function normaliseNextAction(a) {
  if (!a || typeof a !== 'object' || !REVIEW_ACTIONS.includes(a.type)) return null;
  const by = typeof a.by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.by) ? a.by : null;
  return { type: a.type, by };
}

// ---------------------------------------------------------------------------
// Is this email of OURS the Stage 2 request? Read from the words, with no AI,
// so an email sent from here moves the complaint on whichever button sent it
// (and the page can offer "Send it and escalate" whatever the review called
// its next step). Strict on purpose: a chaser that says "if this isn't put
// right we will ask for Stage 2" is not the request, so a sentence that
// only threatens it (if / unless / otherwise / will / may) never counts.
//   subject: "… request for Stage 2 review", "Stage 2 request",
//            "Escalation to Stage 2"
//   body:    "We therefore ask that the complaint is passed … for an
//            independent internal review (Stage 2)", "please escalate our
//            complaint to Stage 2", "we are escalating this to Stage 2"
// ---------------------------------------------------------------------------
const STAGE2 = String.raw`stage\s*(?:2|two)\b`;
// The subject alone can say it: "… request for Stage 2 review", "Stage 2
// request", "Escalation to Stage 2" — unless it is a chaser.
const SUBJECT_STAGE2 = new RegExp(
  String.raw`\brequest(?:ing)?\s+(?:for\s+)?(?:an?\s+)?${STAGE2}\s*(?:review|escalation)\b` +
  String.raw`|\b${STAGE2}\s*(?:review\s+)?request\b|\bescalat(?:e|ion|ing)\s+to\s+${STAGE2}`,
  'i',
);
const CHASER_SUBJECT = /\b(?:chas(?:e|er|ing)|reminder|response|reply|follow[-\s]?up)\b/i;

// In the body, a sentence is the request when it has all three, in order:
//   1. an ask made now, by us: "we ask / request / are requesting / would
//      like / wish", "please", "kindly", "could you", "we would be grateful",
//      "we are writing to ask", "we are escalating", "as our request";
//   2. what is asked: escalated / passed / referred / moved / progressed /
//      reviewed / considered / a review / a request;
//   3. Stage 2 itself ("Stage 2", "stage two", "the second stage", "an
//      independent review") — never their Stage 2 RESPONSE, which is a
//      chaser at Stage 2.
// And it is not the request when:
//   - a condition or a future stands before the ask ("If …", "Failing …",
//     "Before …", "Should you …", "we will …");
//   - the ask itself is negative ("please do not escalate", "is not needed");
//   - a negative condition follows ("… to Stage 2 if you do not reply");
//   - it reports an earlier request ("we asked for …", "confirm you received
//     our request to …").
// A reason before the ask is only a reason: "As you have not responded, we
// request that it is escalated to Stage 2" IS the request.
const ASK = new RegExp(String.raw`\b(?:` + [
  String.raw`we\s+(?:(?:therefore|now|hereby|formally|also|would\s+now|must\s+now)\s+)*(?:ask|request|are\s+(?:now\s+)?(?:requesting|asking)|would\s+like|wish|want|are\s+(?:now\s+)?escalating|are\s+writing\s+to\s+(?:ask|request))`,
  String.raw`we\s+would\s+be\s+grateful`,
  String.raw`please`, String.raw`kindly`, String.raw`could\s+you`, String.raw`can\s+you`,
  String.raw`(?:this\s+is|as)\s+(?:our|a)\s+(?:formal\s+)?request`,
].join('|') + String.raw`)\b`, 'i');
const ACTION = /\b(?:escalat\w*|pass(?:ed|ing)?|refer(?:red|ring)?|mov(?:e|ed|ing)|progress(?:ed|ing)?|review(?:ed|ing)?|consider(?:ed|ing)?|request|take[n]?|look(?:ed)?\s+at)\b/i;
const TARGET = new RegExp(
  String.raw`\b(?:${STAGE2}|second[-\s]stage|independent\s+(?:internal\s+)?review)(?!\s*(?:\(\s*)?(?:response|reply|outcome|decision|answer|letter|timescale|deadline|findings)\b)`,
  'i',
);
const CONDITION_BEFORE = /\b(?:if|unless|otherwise|failing|before|until|will|shall|intend|going\s+to|should\s+(?:you|we|they|this|it|the|your|there|no))\b/i;
const NEGATIVE = /\b(?:not|no|never)\b|n['’]t\b/i;
const REPORTS_EARLIER = /\bwe\s+(?:have\s+)?(?:already\s+)?(?:asked|requested)\b|\b(?:received|receipt\s+of|acknowledg\w*|following|further\s+to|regarding|about|chas\w*)\s+(?:of\s+)?our\s+(?:earlier\s+|previous\s+|last\s+)?(?:request|email|letter)\b/i;

function asksForStage2(sentence) {
  // "grateful if you could …" is politeness, not a condition.
  const s = sentence.replace(/\bif\s+you\s+(?:could|would|can)\b/gi, 'you could');
  const ask = ASK.exec(s);
  if (!ask) return false;
  const afterAsk = s.slice(ask.index);
  const target = TARGET.exec(afterAsk);
  if (!target) return false;
  const span = afterAsk.slice(0, target.index + target[0].length); // the ask up to Stage 2
  if (!ACTION.test(span)) return false;
  if (CONDITION_BEFORE.test(s.slice(0, ask.index)) || CONDITION_BEFORE.test(span)) return false;
  if (NEGATIVE.test(span)) return false;
  if (REPORTS_EARLIER.test(s)) return false;
  const rest = afterAsk.slice(target.index + target[0].length);
  // "… a second stage review is not needed": turned down, not asked for.
  if (/^\W*(?:\w+\s+){0,2}(?:is|are|was|would\s+be)\s+(?:not|n['’]t)\b|^\W*(?:\w+\s+){0,2}(?:isn|aren|wasn)['’]t\b/i.test(rest)) return false;
  if (/\b(?:if|unless)\b.{0,60}(?:\b(?:not|no|fail\w*|still)\b|n['’]t\b)|\botherwise\b|\bfailing\b/i.test(rest)) return false;
  return true;
}

export function isStage2Request(email) {
  const subject = String(email?.subject || '');
  const body = String(email?.body || '');
  if (SUBJECT_STAGE2.test(subject) && !CHASER_SUBJECT.test(subject) && !/\b(?:if|unless|not|no)\b/i.test(subject)) return true;
  // Quoted history below the reply is theirs or older: only our own words.
  const own = body.split(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,80} wrote:)/i)[0];
  // A semicolon starts a clause of its own ("… a Stage 1 response; a Stage 2
  // review is not needed"), so the ask and Stage 2 must be in one clause.
  return own.split(/(?<=[.!?;])\s+|\n+/).some(asksForStage2);
}

// ---------------------------------------------------------------------------
// Stage 2 requests of ours the complaint hasn't caught up with: an email we
// sent asks for Stage 2, yet the organisation it went to is still at Stage 1
// (sent before the words were recognised, or from Outlook with nothing
// recorded). Pure; the page prompts with it and start-up acts on the certain
// ones sent from here.
//   tracks: [{ party_id (null = main), org_name, stage, state, raised_on }]
//   emails: our emails, [{ id, subject, body, sent_on, party_id, from_here, our_step }]
//   events: [{ type, party_id, event_date, note }]
// Returns one per track (its latest such email): { email_id, subject,
// sent_on, party_id, org_name, certain, from_here }. `certain`: the words
// (or the email analysis) say it is the request; otherwise it only mentions
// escalating to Stage 2 and a person decides.
// ---------------------------------------------------------------------------
const MENTIONS_STAGE2 = new RegExp(
  String.raw`\bescalat\w*\b.{0,80}\b(?:${STAGE2}|second[-\s]stage)(?!\s*(?:response|reply|outcome|decision|answer)\b)` +
  String.raw`|\b(?:${STAGE2}|second[-\s]stage)\s+(?:review|escalation|request)\b`,
  'i',
);
export function missedStage2Requests(tracks, emails, events = []) {
  const found = new Map();
  const sorted = [...emails].filter((e) => e.sent_on).sort((a, b) => a.sent_on.localeCompare(b.sent_on));
  for (const e of sorted) {
    const certain = e.our_step === 'stage2_request' || isStage2Request(e);
    // Not certain: offered only if a sentence of ours speaks of escalating to
    // Stage 2 without a condition or a future ("if we don't hear by Friday,
    // we will escalate…" is a chaser, and must not raise the prompt).
    const own = String(e.body || '').split(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,80} wrote:)/i)[0];
    const loose = [e.subject || '', ...own.split(/(?<=[.!?;])\s+|\n+/)]
      .some((x) => MENTIONS_STAGE2.test(x) && !CONDITION_BEFORE.test(x) && !NEGATIVE.test(x));
    if (!certain && !loose) continue;
    // Whose track: the one it was sent for; with one organisation, that one;
    // sent from here with none named, the main one. Otherwise a person says.
    const t = e.party_id ? tracks.find((x) => x.party_id === e.party_id)
      : tracks.length === 1 || e.from_here ? tracks.find((x) => !x.party_id) : null;
    if (!t || !trackOpen(t) || t.stage !== 'stage_1' || (t.raised_on && e.sent_on < t.raised_on)) continue;
    // A person put it back to Stage 1 (or recorded an escalation) after it
    // was sent: their decision stands.
    const later = events.some((ev) => (ev.party_id || null) === (t.party_id || null) && ev.event_date >= e.sent_on &&
      (ev.type === 'escalated' || /^(?:Details corrected:|Automatic record from the email).*\bstage\b/i.test(ev.note || '')));
    if (later) continue;
    // The latest per organisation, but a certain request is never replaced
    // by a later email that only mentions Stage 2.
    const prev = found.get(t.party_id || 'main');
    if (prev?.certain && !certain) continue;
    found.set(t.party_id || 'main', {
      email_id: e.id, subject: e.subject || '', sent_on: e.sent_on, party_id: t.party_id || null,
      org_name: t.org_name, certain, from_here: Boolean(e.from_here),
    });
  }
  return [...found.values()];
}
