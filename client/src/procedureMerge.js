// The figures of a procedure. Each keeps a note of where it came from
// (procedure_sources): 'document', 'research' or 'entered'.
export const FIGURES = [
  'ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock',
  'ombudsman_name', 'ombudsman_url', 'ombudsman_referral_months', 'referral_from', 'ombudsman_after_weeks',
];
// 0 is never a real timescale: it is what an unstated figure used to become.
export const blank = (x) => x === '' || x === null || x === undefined || x === 0 || x === '0';

// The standard for this kind of organisation (from GET /organisations/defaults),
// by form field.
const STANDARD_KEY = {
  ack_days: 'ackDays', stage1_response_days: 'stage1Days', stage2_response_days: 'stage2Days',
  ombudsman_name: 'ombudsman', ombudsman_url: 'ombudsmanUrl', ombudsman_referral_months: 'referralMonths',
  ombudsman_after_weeks: 'ombudsmanAfterWeeks',
};

// Fill every figure nobody has given with the standard one, marked
// 'standard', so the form shows real figures (as it did when first set up)
// and says plainly they are the standard. A figure already standard follows a
// change of type.
export function fillStandard(f, defaults) {
  if (!defaults) return f;
  const out = { ...f };
  const sources = { ...(f.procedure_sources || {}) };
  let changed = false;
  for (const [k, dk] of Object.entries(STANDARD_KEY)) {
    // A standard counted in calendar WEEKS (a debt collector's 8) has no
    // working-days figure to show: left blank, so the standard itself
    // applies, rather than an approximate day count that dates it later.
    if (k === 'stage1_response_days' && defaults.stage1Weeks) {
      if (sources[k] === 'standard') {
        out[k] = '';
        delete sources[k];
        changed = true;
      }
      continue;
    }
    const std = defaults[dk];
    if (std === null || std === undefined || std === '') continue;
    if (blank(out[k]) || sources[k] === 'standard') {
      if (out[k] !== std || sources[k] !== 'standard') changed = true;
      out[k] = std;
      sources[k] = 'standard';
    }
  }
  if (!changed) return f;
  out.procedure_sources = sources;
  return out;
}

// The gaps worth paying for research after reading their document: their
// own timescales. The ombudsman figures are the scheme's (the register
// replaces them), and a clock the document doesn't mention is the usual one;
// neither is a reason to spend credits. A standard counted in weeks (a debt
// collector's 8) has no working-days figure to find.
export function researchGaps(f, defaults) {
  return ['ack_days', 'stage1_response_days', 'stage2_response_days']
    .filter((k) => !(k === 'stage1_response_days' && defaults?.stage1Weeks))
    .filter((k) => blank(f[k]) || f.procedure_sources?.[k] === 'standard');
}

// Merge a researched or read profile into the form, figure by figure:
//   - their procedure DOCUMENT wins wherever it states a figure;
//   - anything it doesn't state keeps the figure already there (researched
//     earlier, or typed in), with its own quote and source;
//   - RESEARCH only fills figures that are blank or were themselves
//     researched; it never overrides their document or what someone typed.
// Nothing is wiped because one source happens not to mention it.
export function mergeProfile(f, p, source) {
  const out = { ...f };
  const evidence = { ...(f.procedure_evidence || {}) };
  const sources = { ...(f.procedure_sources || {}) };
  const took = [];
  for (const k of FIGURES) {
    const v = p[k];
    if (blank(v)) continue;
    const current = sources[k];
    const mayReplace = source === 'document' ? true
      : blank(f[k]) || current === 'research' || current === 'standard' || (!current && f.research_status === 'researched');
    if (!mayReplace) continue;
    out[k] = v;
    sources[k] = source;
    if (p.evidence?.[k]) evidence[k] = p.evidence[k];
    else delete evidence[k];
    took.push(k);
  }
  if (source === 'research') out.researched_now = true;
  // The name's quote travels with the name: research's quote never sits
  // beside the document's name.
  const tookRef = p.procedure_ref && (source === 'document' || blank(f.procedure_ref));
  if (tookRef) {
    out.procedure_ref = p.procedure_ref;
    if (p.evidence?.procedure_ref) evidence.procedure_ref = p.evidence.procedure_ref;
    else delete evidence.procedure_ref;
  }
  out.complaints_email = f.complaints_email || p.complaints_email || '';
  out.complaints_url = f.complaints_url || p.complaints_url || '';
  out.phone = f.phone || p.phone || '';
  if (p.procedure_summary && (source === 'document' || !f.procedure_summary)) out.procedure_summary = p.procedure_summary;
  if (p.legal_basis && (source === 'document' || !f.legal_basis)) out.legal_basis = p.legal_basis;
  if (p.sources?.length) {
    const seen = new Set((f.sources || []).map((x) => x.url));
    out.sources = [...(f.sources || []), ...p.sources.filter((x) => !seen.has(x.url))];
  }
  out.procedure_evidence = evidence;
  out.procedure_sources = sources;
  // Only what is still blank after both is "not stated" (and then the
  // standard for this kind of organisation applies, and says so).
  out.unconfirmed = FIGURES.filter((k) => blank(out[k]) || out.procedure_sources?.[k] === 'standard');
  out.research_status = source === 'document' || f.research_status === 'document' ? 'document' : source === 'research' ? 'researched' : f.research_status;
  out.verified = false; // new figures have not been checked by anyone yet
  return { form: out, took };
}

