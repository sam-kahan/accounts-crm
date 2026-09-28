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
  other: 'this kind of organisation',
};

export function effectiveRule(org, type) {
  const base = {
    stage1Clock: 'receipt',
    referralFrom: 'raised',
    ombudsmanAfterWeeks: null,
    ...ruleFor(type || org?.type),
  };
  const rule = { ...base, procedureRef: null, defaulted: Object.keys(ORG_FIELDS), kind: KIND_PHRASE[type || org?.type] || KIND_PHRASE.other };
  if (!org) return rule;
  const defaulted = [];
  for (const [key, col] of Object.entries(ORG_FIELDS)) {
    const v = org[col];
    if (v === null || v === undefined || v === '') defaulted.push(key);
    else rule[key] = v;
  }
  rule.defaulted = defaulted;
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

const stageStart = (c) => c.stage_started_on || c.raised_on;

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
    return `the standard for ${rule.kind || 'this kind of organisation'} (their procedure doesn't set one)`;
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
  if (complaint.state === 'resolved')
    return { ...base, status: 'resolved', label: 'Resolved', nextAction: null };
  if (complaint.state === 'closed')
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
  const referNote = canReferNow
    ? ` You can also refer it to ${theOmbudsman(rule.ombudsman)} now.`
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
      nextAction: null,
    };
  }
  const label =
    wd !== null ? `Awaiting response, due in ${plural(wd)}` : 'Awaiting response';
  return { ...base, status: 'awaiting_response', label, nextAction: referNote.trim() || null };
}

// The complaint's procedure as a checklist: every step their procedure sets,
// with the date it falls on and where it stands. Pure, so the screen, the AI
// assistant and the tests all read the same answer.
//   state: done | overdue | due | upcoming | available | missed | past | pending
export function procedureSteps(complaint, rule) {
  const today = todayISO();
  const stage = complaint.stage || 'stage_1';
  const closed = complaint.state === 'resolved' || complaint.state === 'closed';
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

  const s1Note =
    rule.stage1Clock === 'acknowledgement'
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
    else out.push(`${label}: ${a ?? '(blank)'} → ${b ?? '(blank)'}`);
  }
  return out;
}

// What an AI review was written against. When this changes, the review is out
// of date (the nightly job and the page both use it).
export function reviewSignature(c) {
  return [c.status, c.stage, c.state, c.acknowledged_on, c.responded_on, c.final_response_on,
    c.response_due].map((v) => v ?? '').join('|');
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
