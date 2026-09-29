// ---------------------------------------------------------------------------
// Did a save change anything that sets a complaint's dates? Decides whether
// "checked against their procedure" keeps who checked it and when (nothing
// procedural changed: a phone number, a note) or is stamped afresh, and
// whether its complaints' AI reviews are worth refreshing. Pure and tested.
//
// A figure marked 'standard' was only filled in to SHOW the standard (their
// procedure gives none), so it counts as not stated: opening the form fills
// blanks with the standard, and that must never read as a change. The
// ombudsman scheme is part of the procedure too (it sets the wait and the
// time limit).
// ---------------------------------------------------------------------------

export const PROC_FIELDS = [
  'type', 'ombudsman_name', 'ombudsman_url', 'ombudsman_referral_months', 'stage1_response_days',
  'stage2_response_days', 'ack_days', 'procedure_ref', 'stage1_clock', 'ombudsman_after_weeks', 'referral_from',
];

const norm = (v) => (v === '' || v === undefined || v === null || v === 0 || v === '0' ? null : String(v));

// `old`: the row as it was. `next`: the values being saved (as stored), with
// `procedure_sources` and `ombudsman_id` when the form sent them (undefined =
// left as it was).
export function procedureChanged(old, next) {
  const oldSrc = old.procedure_sources || {};
  const newSrc = next.procedure_sources === undefined ? oldSrc : next.procedure_sources || {};
  for (const f of PROC_FIELDS) {
    const o = oldSrc[f] === 'standard' ? null : norm(old[f]);
    const n = newSrc[f] === 'standard' ? null : norm(next[f]);
    if (o !== n) return true;
  }
  if (next.ombudsman_id !== undefined && (old.ombudsman_id || null) !== (next.ombudsman_id || null)) return true;
  return false;
}

// Is anything of their own procedure on the form: a figure that isn't only
// the standard, or the name of their procedure document.
export function statesOwnProcedure(f) {
  const src = f.procedure_sources || {};
  const figures = ['ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock',
    'ombudsman_after_weeks', 'ombudsman_referral_months', 'referral_from'];
  return Boolean(norm(f.procedure_ref)) || figures.some((k) => norm(f[k]) !== null && src[k] !== 'standard');
}
