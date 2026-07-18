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

function addMonths(dateStr, months) {
  if (!dateStr || !months) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
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
      'Council complaint timescales vary by authority (commonly ~10 working days at Stage 1, ~20 at Stage 2). The LGSCO can investigate once the council’s process is exhausted — normally refer within 12 months of becoming aware of the problem.',
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
    deadlockWeeks: 8,
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
      'No single statutory timescale — a reasonable response is around 10 working days. Check whether the supplier belongs to an ADR/ombudsman scheme; consider Trading Standards if ignored.',
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

export function ruleFor(type) {
  return RULES[type] || RULES.other;
}

// Merge an organisation's researched/edited overrides onto the type defaults.
export function effectiveRule(org, type) {
  const base = ruleFor(type || org?.type);
  if (!org) return base;
  return {
    ...base,
    stage1Days: org.stage1_response_days ?? base.stage1Days,
    stage2Days: org.stage2_response_days ?? base.stage2Days,
    ackDays: org.ack_days ?? base.ackDays,
    ombudsman: org.ombudsman_name || base.ombudsman,
    ombudsmanUrl: org.ombudsman_url || base.ombudsmanUrl,
    referralMonths: org.ombudsman_referral_months ?? base.referralMonths,
    legalBasis: org.legal_basis || base.legalBasis,
  };
}

// Compute the suggested response-due date for a complaint at its current stage.
export function computeResponseDue(complaint, rule) {
  const days = complaint.stage === 'stage_2' ? rule.stage2Days : rule.stage1Days;
  return addWorkingDays(complaint.raised_on, days);
}

// Compute the ombudsman referral deadline (from when the problem was raised).
export function computeOmbudsmanDeadline(complaint, rule) {
  return addMonths(complaint.raised_on, rule.referralMonths);
}

// Derive live status + a plain-English "next action" for a complaint.
export function deriveStatus(complaint, rule) {
  if (complaint.state === 'resolved')
    return { status: 'resolved', label: 'Resolved', nextAction: null, overdue: false };
  if (complaint.state === 'closed')
    return { status: 'closed', label: 'Closed', nextAction: null, overdue: false };

  const responded = Boolean(complaint.responded_on);
  const due = complaint.response_due;
  const wd = due ? workingDaysUntil(due) : null;
  const overdue = !responded && wd !== null && wd < 0;

  let status = 'awaiting_response';
  let label = 'Awaiting response';
  let nextAction = null;

  if (responded) {
    status = 'responded';
    label = 'Response received';
    if (complaint.stage === 'stage_1') {
      nextAction =
        'Response received. If unresolved, escalate to Stage 2 of their complaints process.';
    } else if (complaint.stage === 'stage_2') {
      nextAction = `Stage 2 response received. If still unresolved, you can refer to the ${rule.ombudsman}.`;
    }
  } else if (overdue) {
    status = 'response_overdue';
    label = `No response — ${Math.abs(wd)} working days overdue`;
    if (complaint.stage === 'stage_1') {
      nextAction = `No Stage 1 response within the expected ${rule.stage1Days} working days. Chase in writing; if still ignored you can escalate to Stage 2 (failure to respond is a complaint-handling failure).`;
    } else {
      nextAction = `No Stage 2 response within the expected ${rule.stage2Days} working days. You can now refer the complaint to the ${rule.ombudsman}, citing their failure to respond.`;
    }
  } else if (wd !== null) {
    label = `Awaiting response — due in ${wd} working day${wd === 1 ? '' : 's'}`;
  }

  return { status, label, nextAction, overdue };
}
