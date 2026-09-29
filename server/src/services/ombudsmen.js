import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// The ombudsman register (migration 042): which scheme an organisation's
// complaints go to, and that scheme's own rules for taking a case. Read by
// the rules engine (complaintRules.js#effectiveRule / referralOpen) so the
// deadlines and "can it go now" come from a record a person has checked,
// never from code.
// ---------------------------------------------------------------------------

// The usual scheme for each kind of organisation. A managing agent belongs to
// The Property Ombudsman OR the Property Redress Scheme, and a supplier or
// "other" to whatever scheme it joined (if any): those are chosen on the
// organisation, never assumed.
export const DEFAULT_SCHEME = {
  energy: 'energy_ombudsman',
  housing_association: 'housing_ombudsman',
  council: 'lgsco',
  water: 'ccw',
  debt_collector: 'fos',
};

export async function loadSchemes() {
  return (await query('SELECT * FROM ombudsmen ORDER BY name')).rows;
}

// The scheme for an organisation (or a type with no saved organisation): the
// one chosen on it, else the usual one for its type. Null when there is none.
export function schemeFor(org, type, schemes) {
  if (org?.ombudsman_id) return schemes.find((s) => s.id === org.ombudsman_id) || null;
  const key = DEFAULT_SCHEME[org?.type || type];
  return key ? schemes.find((s) => s.key === key) || null : null;
}

// The organisations whose complaints a scheme's rules apply to: chosen on
// them, or the usual one for their type with nothing chosen.
export async function organisationsUsing(scheme) {
  const types = Object.entries(DEFAULT_SCHEME).filter(([, k]) => k === scheme.key).map(([t]) => t);
  return (await query(
    `SELECT id FROM organisations WHERE ombudsman_id = $1 OR (ombudsman_id IS NULL AND type = ANY($2::text[]))`,
    [scheme.id, types],
  )).rows.map((r) => r.id);
}
