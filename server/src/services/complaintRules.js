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

// England & Wales bank holidays 2025–2030 (YYYY-MM-DD). 2029 and 2030 are
// the regular pattern (Easter worked out; the government publishes each year
// later): a one-off added by proclamation must be added here. A date past the
// last year here is counted without bank holidays, and the server log says so.
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
  // 2029
  '2029-01-01', '2029-03-30', '2029-04-02', '2029-05-07', '2029-05-28',
  '2029-08-27', '2029-12-25', '2029-12-26',
  // 2030
  '2030-01-01', '2030-04-19', '2030-04-22', '2030-05-06', '2030-05-27',
  '2030-08-26', '2030-12-25', '2030-12-26',
]);
const LAST_HOLIDAY_YEAR = 2030;
let warnedPastHolidays = false;

import { todayISO } from '../lib/dates.js';

const iso = (d) => d.toISOString().slice(0, 10);

function isWorkingDay(d) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // Sun/Sat
  if (d.getUTCFullYear() > LAST_HOLIDAY_YEAR && !warnedPastHolidays) {
    warnedPastHolidays = true;
    console.warn(`[complaints] a deadline runs past ${LAST_HOLIDAY_YEAR}: add that year's bank holidays to complaintRules.js`);
  }
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
    // The Code counts each stage's response from the landlord's
    // ACKNOWLEDGEMENT (5.6, 6.13), not from receipt: until they acknowledge,
    // the latest they may is assumed (5 working days, 5.1 and 6.11).
    stage1Clock: 'acknowledgement',
    stage2AckDays: 5,
    ombudsman: 'Housing Ombudsman',
    ombudsmanUrl: 'https://www.housing-ombudsman.org.uk/',
    referralMonths: 12,
    legalBasis:
      'Housing Ombudsman Complaint Handling Code (statutory from 1 Apr 2024): acknowledge within 5 working days; Stage 1 response within 10 working days of the acknowledgement; Stage 2 acknowledged within 5 working days and answered within 20 working days of that acknowledgement.',
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
  debt_collector: 'a debt collector, set by the FCA',
  other: 'this kind of organisation',
};

// The rule for a complaint: the type's defaults, the organisation's own
// procedure on top, and — when `scheme` is given (services/ombudsmen.js
// #schemeFor: a record, or null for none) — the ombudsman's own rules for
// WHEN a case can go and the time limit, which only the scheme can set. Left
// out (undefined), no register is consulted (the pure tests of the rest).
export function effectiveRule(org, type, scheme) {
  const rule = orgRule(org, type);
  return scheme === undefined ? rule : applyScheme(rule, scheme);
}

const FROM_SCHEME = ['ombudsman', 'ombudsmanUrl', 'ombudsmanAfterWeeks', 'referralMonths', 'referralFrom'];
function applyScheme(rule, s) {
  if (!s) return { ...rule, scheme: null };
  const out = { ...rule, sourceOf: { ...(rule.sourceOf || {}) } };
  out.ombudsman = s.name;
  out.ombudsmanUrl = s.website || s.refer_url || '';
  out.ombudsmanAfterWeeks = s.wait_weeks ?? null;
  // The scheme's own time limit, or none: a scheme whose limit isn't known
  // gets no "refer by" date, never the type default passed off as its rule.
  out.referralMonths = s.time_limit_months || null;
  out.referralFrom = s.time_limit_from || 'raised';
  out.defaulted = (rule.defaulted || []).filter((k) => !FROM_SCHEME.includes(k));
  for (const k of FROM_SCHEME) out.sourceOf[k] = 'ombudsman_register';
  out.scheme = {
    id: s.id, key: s.key, name: s.name, website: s.website || null, refer_url: s.refer_url || null,
    phone: s.phone || null, email: s.email || null, post: s.post || null,
    refer_email: s.refer_email || null, refer_email_note: s.refer_email_note || null,
    who_can_complain: s.who_can_complain || null, representative: s.representative || null,
    what_to_include: s.what_to_include || [], notes: s.notes || null,
    after_final_response: s.after_final_response !== false, after_missed_deadline: Boolean(s.after_missed_deadline),
    verified: Boolean(s.verified_at), verified_at: s.verified_at || null, verified_by: s.verified_by || null,
  };
  return out;
}

function orgRule(org, type) {
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

// A complaint logged here before it was sent to them (`not_sent_yet`, set
// only when a person says so on the Log form, never guessed): nothing can be
// due from them, so the page offers to draft and send it instead of "wait for
// their acknowledgement". Anything from them (an acknowledgement, a response)
// means it has gone, whatever the flag says.
export function awaitingFirstEmail(c) {
  if (!c?.not_sent_yet || (c.state || 'open') !== 'open') return false;
  return c.stage === 'stage_1' && !c.acknowledged_on && !c.responded_on && !c.final_response_on;
}

// Greenco's rule: a complaint is made only by an email or letter that USES
// THE WORD — making a complaint, or asking for one to be opened, logged or
// raised ("we wish to make a formal complaint", "I am writing to complain",
// their complaints form). However unhappy an email is, without the word it is
// a request or a dispute, and the complaint's clock (every deadline, the
// ombudsman's wait and time limit) starts only from the email that asks for
// the complaint. Checked in code against the sentence the AI quotes, never
// left to the AI alone.
export const COMPLAINT_WORD = /\bcomplain(?:t|ts|ing|ed|s)?\b/i;
export function usesComplaintWord(text) {
  return COMPLAINT_WORD.test(String(text || ''));
}

// The AI's reading of whether (and when) a complaint was made, held to that
// rule: is_complaint stands only with a quoted sentence that uses the word,
// and the complaint was made on that sentence's date.
export function holdToComplaintWord(r) {
  if (!r || typeof r !== 'object' || r.is_complaint === false) return r;
  const quote = typeof r.complaint_evidence?.quote === 'string' ? r.complaint_evidence.quote.trim() : '';
  if (!usesComplaintWord(quote)) {
    const why = quote
      ? 'the sentence it relies on doesn’t use the word “complaint”, so no complaint has been asked for yet'
      : 'no email or letter asks for a complaint in so many words (the word “complaint”), so none has been made yet';
    return {
      ...r, is_complaint: false, complaint_evidence: null, not_complaint_why: why,
      raised_on: null, acknowledged_on: null, responded_on: null, stage: 'stage_1',
      notes: `Not a formal complaint yet: ${why}.${r.notes ? ` ${r.notes}` : ''}`,
    };
  }
  const date = typeof r.complaint_evidence?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.complaint_evidence.date)
    ? r.complaint_evidence.date : null;
  return { ...r, raised_on: date || r.raised_on || null };
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
      ? `the standard for ${rule.kind || 'this kind of organisation'}; their own procedure hasn't been researched yet`
      : `the standard for ${rule.kind || 'this kind of organisation'}; their procedure doesn't set one`;
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
  if (stage === 'stage_2') {
    // Stage 2 has no clock without the day it was asked for: never the date
    // the complaint was made standing in (weeks early, and chased).
    if (!complaint.stage_started_on) return null;
    // Counted from their acknowledgement of the Stage 2 request where the
    // rules say so (housing): the latest they may acknowledge it, as no
    // Stage 2 acknowledgement is recorded.
    const from = rule.stage2AckDays ? addWorkingDays(start, rule.stage2AckDays) : start;
    return addWorkingDays(from, rule.stage2Days);
  }
  return null;
}

// The last day to refer to the ombudsman. Counted from the complaint being
// raised unless the body's window runs from its final response, in which case
// there is no date until that response arrives — a guess would be a deadline
// nobody could rely on.
// The time limit to refer, in words ("12 months from their final response"),
// or that it isn't known for this scheme.
export function referLimitText(rule) {
  if (!rule.referralMonths) return `the time limit for ${theOmbudsman(rule.ombudsman)} isn’t known yet (see its record under Ombudsmen)`;
  return `${rule.referralMonths} months from ${rule.referralFrom === 'final_response' ? 'their final response' : 'when the complaint was made'}`;
}

export function computeOmbudsmanDeadline(complaint, rule) {
  if (!rule.referralMonths) return null; // not known for this scheme
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
  // Their final response opens it, unless the scheme says it doesn't.
  const finalOpens = rule.scheme?.after_final_response !== false ? complaint.final_response_on : null;
  const dates = [early, finalOpens].filter(Boolean).sort();
  return dates[0] || null;
}

const plural = (n, word) => `${n} working day${n === 1 ? '' : 's'}${word ? ` ${word}` : ''}`;

// Derive live status + a plain-English "next action" for a complaint.
// Can this organisation's part go to the ombudsman NOW? Going too early gets
// a complaint turned away, so this is strict, and everything that suggests or
// records a referral asks it (the dates' next step, the AI review's guard,
// the Refer button). `t` is a track with ombudsman_from (computeOmbudsmanFrom)
// and its rule. Open only when:
//   - it has been checked (an imported complaint nobody has confirmed, or one
//     with an unanswered question about it, rests on dates that may be wrong);
//   - and the ombudsman's own wait is over (e.g. 8 weeks for energy) or their
//     final response has come;
//   - or, where the scheme sets no wait, they have missed their Stage 2
//     deadline (their procedure has run out).
// Returns { open, from, why }: `from` the day it opens (when known), `why`
// a sentence part saying why not.
export function referralOpen(t, today = todayISO()) {
  if (t.stage === 'ombudsman') return { open: true, from: null, why: null };
  if (awaitingFirstEmail(t)) return { open: false, from: null, why: 'the complaint hasn’t been sent to them yet' };
  const doubt = t.complaint_doubt && !t.complaint_doubt.answered ? t.complaint_doubt : null;
  if (doubt) {
    return { open: false, from: null, why: doubt.kind === 'not_complaint'
      ? 'the emails don’t show a formal complaint being made; answer that on the complaint first'
      : 'check the date the complaint was made first (the question on the complaint)' };
  }
  if (t.needs_check) {
    return { open: false, from: null, why: `this imported complaint hasn’t been checked: confirm the date it was made (recorded as ${ukDate(t.raised_on)}) and press Looks right first` };
  }
  // The scheme's own rules decide, and only once a person has checked them
  // (Complaints → Ombudsmen). Without a register lookup (the pure tests) this
  // is skipped.
  if (t.rule && 'scheme' in t.rule) {
    const s = t.rule.scheme;
    if (!s) return { open: false, from: null, why: 'no ombudsman scheme is set for this organisation: choose the scheme it belongs to on the Organisations page' };
    if (!s.verified) return { open: false, from: null, why: `${theOmbudsman(s.name)}’s rules in the system haven’t been checked yet (Complaints → Ombudsmen)` };
  }
  const from = t.ombudsman_from || null;
  if (from && from <= today) return { open: true, from, why: null };
  const weeks = t.rule?.ombudsmanAfterWeeks;
  if (from) {
    const basis = t.final_response_on === from ? `their final response on ${ukDate(from)}`
      : weeks ? `${weeks} week${weeks === 1 ? '' : 's'} after the complaint was made on ${ukDate(t.raised_on)}` : null;
    return { open: false, from, why: `${theOmbudsman(t.rule?.ombudsman)} can’t take it until ${ukDate(from)}${basis ? ` (${basis})` : ''}` };
  }
  if (t.stage === 'stage_2' && t.response_due && t.response_due < today && !t.responded_on &&
      (!t.rule?.scheme || t.rule.scheme.after_missed_deadline)) return { open: true, from: null, why: null };
  return { open: false, from: null, why: 'their complaints procedure hasn’t finished yet: there is no final response' };
}

export function deriveStatus(complaint, rule) {
  const base = { overdue: false, ack_overdue: false, needs_chasing: false };
  if (complaint.state === 'resolved' || complaint.stage === 'resolved')
    return { ...base, status: 'resolved', label: 'Resolved', nextAction: null };
  if (complaint.state === 'closed' || complaint.stage === 'closed')
    return { ...base, status: 'closed', label: 'Closed', nextAction: null };
  if (awaitingFirstEmail(complaint))
    return {
      ...base,
      status: 'not_sent',
      label: 'Not sent to them yet',
      nextAction: `Send the complaint to ${complaint.org_name || 'them'}: nothing is due from them until it has gone.`,
    };
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
  // Overdue once the date has passed, as the checklist says: a date on a
  // weekend or bank holiday (a calendar-week deadline, one typed in) counts
  // 0 working days away the day after, and was a working day late. The
  // working days are for the label only (at least 1 once it has passed).
  const overdue = !responded && Boolean(due) && due < today;
  const ackDue = computeAckDue(complaint, rule);
  const ackWd = ackDue && !complaint.acknowledged_on ? workingDaysUntil(ackDue) : null;
  const ackOverdue = !responded && ackWd !== null && ackDue < today;
  const late = (n) => Math.max(1, Math.abs(n || 0));
  const referFrom = computeOmbudsmanFrom(complaint, rule);
  const canReferNow = referFrom && referFrom <= today;
  const referral = referralOpen({ ...complaint, ombudsman_from: referFrom, rule }, today);
  // Why a referral is open, with the date it rests on, so a wrong date (an
  // import that took an early email for the complaint) is visible rather
  // than a bare "you can refer". (Unchecked or in question: referralOpen.)
  const referWhy = !canReferNow ? ''
    : complaint.final_response_on && complaint.final_response_on === referFrom
      ? `their final response was on ${ukDate(complaint.final_response_on)}`
      : `${rule.ombudsmanAfterWeeks} week${rule.ombudsmanAfterWeeks === 1 ? ' has' : 's have'} passed since the complaint was made on ${ukDate(complaint.raised_on)}`;
  // By the dates it could go, but it isn't safe yet (not checked, or in
  // question): said so, never "you can refer".
  const referNote = canReferNow
    ? (referral.open
      ? ` You can also refer it to ${theOmbudsman(rule.ombudsman)} now (${referWhy}).`
      : ` Don’t refer it to ${theOmbudsman(rule.ombudsman)} yet: ${referral.why}.`)
    : '';

  if (responded) {
    let nextAction = null;
    if (complaint.stage === 'stage_1' && complaint.final_response_on) {
      // Their final response came at Stage 1: the ombudsman is next, not Stage 2.
      nextAction = referral.open
        ? `Final response received (${ukDate(complaint.final_response_on)}). If still unresolved, you can refer to ${theOmbudsman(rule.ombudsman)}.`
        : `Final response received (${ukDate(complaint.final_response_on)}). Before any referral to ${theOmbudsman(rule.ombudsman)}: ${referral.why}.`;
    } else if (complaint.stage === 'stage_1') {
      nextAction =
        'Stage 1 response received. If it doesn’t resolve things, ask for Stage 2 in writing, ' +
        'setting out each point you want reviewed and why.' + referNote;
    } else if (complaint.stage === 'stage_2') {
      nextAction = referral.open
        ? `Final response received. If still unresolved, you can refer to ${theOmbudsman(rule.ombudsman)}.`
        : `Final response received. Before any referral to ${theOmbudsman(rule.ombudsman)}: ${referral.why}.`;
    }
    return { ...base, status: 'responded', label: 'Response received', nextAction };
  }

  if (overdue) {
    const nextAction =
      complaint.stage === 'stage_1'
        ? `No Stage 1 outcome by ${ukDate(due)} (${basisOf(rule, 'stage1Days')}). Chase in writing; missing the ` +
          'deadline is itself a complaint-handling failure, and you can ask for Stage 2.' + referNote
        : referral.open
          ? `No Stage 2 response by ${ukDate(due)} (${basisOf(rule, 'stage2Days')}). You can refer ` +
            `the complaint to ${theOmbudsman(rule.ombudsman)}, citing their failure to respond.`
          : `No Stage 2 response by ${ukDate(due)} (${basisOf(rule, 'stage2Days')}). Chase them for it. ` +
            `Not the ombudsman yet: ${referral.why}.`;
    return {
      ...base,
      status: 'response_overdue',
      label: `No response, ${plural(late(wd), 'overdue')}`,
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
      label: `Not acknowledged, ${plural(late(ackWd), 'overdue')}`,
      nextAction:
        `They should have acknowledged it by ${ukDate(ackDue)} (${rule.ackDays} working days, ` +
        `${basisOf(rule, 'ackDays')}). Chase for an acknowledgement` +
        (due ? `; the Stage 1 outcome is still due by ${ukDate(due)}.` : '.'),
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
      (canReferNow ? (referral.open
        ? ` If you'd rather not wait, you can already refer it to ${theOmbudsman(rule.ombudsman)} (${referWhy}).`
        : ` Don’t refer it to ${theOmbudsman(rule.ombudsman)} yet: ${referral.why}.`) : ''),
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

  // Not sent yet: every date would run from the day it was logged.
  if (awaitingFirstEmail(complaint)) {
    return [{
      key: 'raised', label: 'Complaint made', date: null, state: 'pending',
      note: 'Not sent to them yet. Their deadlines are worked out from the day it goes.',
    }];
  }
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

  const s2From = rule.stage2AckDays
    ? `${rule.stage2Days} working days from their acknowledgement of the Stage 2 request (due within ${rule.stage2AckDays} working days of it)`
    : `${rule.stage2Days} working days from the Stage 2 request`;
  if (at <= 1 && complaint.final_response_on) {
    // Their Stage 1 answer was their final response (a debt collector's
    // FCA final response, an energy deadlock letter): no Stage 2 to ask for.
    steps.push({
      key: 'stage2', label: 'Stage 2', date: null, state: 'past',
      note: `Not needed: their response of ${ukDate(complaint.final_response_on)} was their final response`,
    });
  } else if (at <= 1) {
    steps.push({
      key: 'stage2', label: 'Stage 2 final response', date: null,
      state: closed ? 'past' : 'upcoming',
      note: `If needed: ask for Stage 2 in writing and they then have ${s2From.replace(' from the Stage 2 request', '')}`,
    });
  } else if (at === 2) {
    steps.push({
      key: 'stage2', label: 'Stage 2 final response due', date: complaint.response_due,
      state: timed(complaint.response_due, Boolean(complaint.responded_on)),
      note: complaint.responded_on
        ? `Final response ${ukDate(complaint.responded_on)}`
        : complaint.stage_started_on
          ? `${s2From} on ${ukDate(complaint.stage_started_on)}${rule.stage2AckDays ? '. This is the latest date, if they acknowledge on time' : ''} (${basisOf(rule, 'stage2Days')})`
          : 'No date until the day the Stage 2 request was made is recorded: add it with Edit details',
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
    // Open by the dates is not enough on an unchecked or questioned record
    // (referralOpen): then it is not shown as available, and says why.
    state: at >= 3 ? 'done' : closed ? 'past' : !from ? 'pending'
      // The date has come, but something else holds it (unchecked, a question
      // to answer, the scheme not checked): 'held', never "later".
      : from <= today ? (referralOpen({ ...complaint, ombudsman_from: from, rule }, today).open ? 'available' : 'held') : 'upcoming',
    note: at >= 3 ? `Referred to ${theOmbudsman(rule.ombudsman)}`
      : from && from <= today && !referralOpen({ ...complaint, ombudsman_from: from, rule }, today).open
        ? `Not yet: ${referralOpen({ ...complaint, ombudsman_from: from, rule }, today).why}`
        : earlyNote,
  });

  const by = complaint.ombudsman_deadline || null;
  steps.push({
    key: 'ombudsman_by', label: 'Refer by', date: by,
    state: at >= 3 ? 'done' : closed ? 'past' : !by ? 'pending' : by < today ? 'overdue' : 'upcoming',
    note: referLimitText(rule) +
      (rule.referralMonths && rule.referralFrom === 'final_response' && !complaint.final_response_on ? ', dated once it arrives' : ''),
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
  ombudsman_deadline: 'refer-by date', outcome_wanted: 'the outcome we want', losses: 'money lost or extra costs',
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
// A review the calendar has overtaken although nothing it was written against
// moved: its "wait until <date>" has passed (for the complaint, or for one of
// its organisations), or a referral has opened or closed since it was
// written (it was told whether one could go). The signature can't see
// either: the dates alone didn't change.
// A wait ends ON its date: "wait until 6 Oct" means act on the 6th (the
// chase hold, reviewGuard.js#chaseHeldUntil, ends that day too), so on the
// 6th the review is out of date. Not one written on its own wait date
// (`reviewedOn`): that would be rewritten on every look.
export function reviewOutrun(review, tracks = [], today, reviewedOn = null) {
  if (!review) return false;
  const passed = (na) => na?.type === 'wait' && na.by &&
    (na.by < today || (na.by === today && Boolean(reviewedOn) && reviewedOn < today));
  if (passed(review.next_action)) return true;
  if (Array.isArray(review.by_org) && review.by_org.some((e) => passed(e?.next_action))) return true;
  if (Array.isArray(review.referral_open) && review.referral_open.length === tracks.length &&
    review.referral_open.some((v, i) => v !== Boolean(tracks[i]?.referral?.open))) return true;
  return false;
}

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
  // Any condition after it makes it a threat, not the request ("… to Stage 2
  // if you cannot resolve it", "… unless …", "… should you be unable …"):
  // "if you could" politeness was already rewritten above.
  if (/\b(?:if|unless|provided|failing|otherwise|in the event|should (?:you|they|it|we|there))\b/i.test(rest)) return false;
  // Asking HOW (or whether) to ask for Stage 2 is not asking for it.
  if (/\b(?:advise (?:us )?how|know how|explain how|tell us how|how (?:we|to|do|can|should|would)|whether)\b/i.test(span)) return false;
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
    // With more than one organisation, an email of ours with no organisation
    // recorded is one Send couldn't place (or whose organisation was taken
    // off since): offered to a person, never certain enough to act on.
    const unplaced = tracks.length > 1 && !e.party_id;
    const certain = !unplaced && (e.our_step === 'stage2_request' || isStage2Request(e));
    const asked = e.our_step === 'stage2_request' || isStage2Request(e);
    // Not certain: offered only if a sentence of ours speaks of escalating to
    // Stage 2 without a condition or a future ("if we don't hear by Friday,
    // we will escalate…" is a chaser, and must not raise the prompt).
    const own = String(e.body || '').split(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,80} wrote:)/i)[0];
    const loose = [e.subject || '', ...own.split(/(?<=[.!?;])\s+|\n+/)]
      .some((x) => MENTIONS_STAGE2.test(x) && !CONDITION_BEFORE.test(x) && !NEGATIVE.test(x));
    if (!asked && !loose) continue;
    // Whose track: the one it was sent for; with one organisation, that one;
    // sent from here with none named, the main one. Otherwise a person says.
    const t = e.party_id ? tracks.find((x) => x.party_id === e.party_id)
      : tracks.length === 1 || e.from_here ? tracks.find((x) => !x.party_id) : null;
    if (!t || !trackOpen(t) || t.stage !== 'stage_1' || (t.raised_on && e.sent_on < t.raised_on)) continue;
    // A person put it back to Stage 1 (or recorded an escalation) after it
    // was sent: their decision stands.
    const later = events.some((ev) => (ev.party_id || null) === (t.party_id || null) && ev.event_date >= e.sent_on &&
      (ev.type === 'escalated' || /^Details corrected:.*\bstage\b/i.test(ev.note || '') ||
        // An Undo that put the stage back (its note says "back to Stage 1"),
        // never one that merely quotes a subject mentioning Stage 2.
        /^(?:Automatic record|What .+ recorded) from the email.*\bback to (?:Stage [12]|the ombudsman)\b/i.test(ev.note || '')));
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

// ---------------------------------------------------------------------------
// A debt collector saying the account is no longer theirs: gone back to (or
// recalled by) their client. Their part of the complaint then ends — they can
// do nothing more about it — while the supplier's part carries on. Pure; read
// sentence by sentence, never from a condition or a future ("if the account
// is returned to our client…").
// ---------------------------------------------------------------------------
const RETURNED = [
  /\b(?:returned|passed|handed|referred|sent|transferred|given)\s+(?:it\s+|the\s+(?:account|debt|file|balance)\s+)?back\b[^.;]{0,60}\b(?:to|by)\s+(?:our|the|their|your)\s+client\b/i,
  /\b(?:returned|referred)\s+(?:it\s+|the\s+(?:account|debt|file|balance)\s+)?to\s+(?:our|the|their)\s+client\b/i,
  /\b(?:our|the)\s+client\s+has\s+(?:recalled|withdrawn|taken\s+back|closed)\b/i,
  /\b(?:recalled|withdrawn)\s+by\s+(?:our|the|their)\s+client\b/i,
  /\b(?:the\s+account|this\s+account|the\s+debt|it)\s+is\s+no\s+longer\s+(?:with\s+us|being\s+(?:managed|handled|collected|pursued)\s+by\s+us|under\s+our\s+management)\b/i,
  /\bwe\s+(?:are|have)\s+no\s+longer\s+(?:acting|instructed|collecting|managing|handling|dealing\s+with)\b/i,
];
const RETURN_CONDITION = /\b(?:if|unless|should|will|would|may|might|could|once|when|until|intend|going\s+to)\b/i;
export function saysReturnedToClient(text) {
  const own = String(text || '').split(/\n\s*(?:-{2,}\s*Original Message|From:\s|On .{5,80} wrote:)/i)[0];
  return own.split(/(?<=[.!?;])\s+|\n+/).some((s) => RETURNED.some((re) => re.test(s)) && !RETURN_CONDITION.test(s));
}
