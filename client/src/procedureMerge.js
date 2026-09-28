// The figures of a procedure. Each keeps a note of where it came from
// (procedure_sources): 'document', 'research' or 'entered'.
export const FIGURES = [
  'ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock',
  'ombudsman_name', 'ombudsman_url', 'ombudsman_referral_months', 'referral_from', 'ombudsman_after_weeks',
];
export const blank = (x) => x === '' || x === null || x === undefined;

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
      : blank(f[k]) || current === 'research' || (!current && f.research_status === 'researched');
    if (!mayReplace) continue;
    out[k] = v;
    sources[k] = source;
    if (p.evidence?.[k]) evidence[k] = p.evidence[k];
    else delete evidence[k];
    took.push(k);
  }
  if (source === 'document' && p.procedure_ref) out.procedure_ref = p.procedure_ref;
  else if (blank(f.procedure_ref) && p.procedure_ref) out.procedure_ref = p.procedure_ref;
  if (p.evidence?.procedure_ref) evidence.procedure_ref = p.evidence.procedure_ref;
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
  out.unconfirmed = FIGURES.filter((k) => blank(out[k]));
  out.research_status = source === 'document' || f.research_status === 'document' ? 'document' : source === 'research' ? 'researched' : f.research_status;
  out.verified = false; // new figures have not been checked by anyone yet
  return { form: out, took };
}

