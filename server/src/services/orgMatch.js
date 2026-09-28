import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Matching names read off emails and documents to what is already on file.
// Names come through with noise (Ltd/Limited, "&"/"and", "the") and are often
// shortened ("LivingCity" for "Livingcity Asset Management Limited"), so there
// are two tiers: an exact match after cleaning, then a prefix match — one name
// is the start of the other — accepted only when exactly one saved
// organisation fits and the shorter name isn't trivially short. A half-right
// guess would apply another body's procedure, so anything ambiguous is no match.
// ---------------------------------------------------------------------------

export function orgKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\blimited\b/g, 'ltd').replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const compact = (name) => orgKey(name).replace(/\s+/g, '');

export function matchOrgName(orgs, name) {
  const k = orgKey(name);
  if (!k) return null;
  const exact = orgs.find((o) => orgKey(o.name) === k);
  if (exact) return exact;
  const c = compact(name);
  const hits = orgs.filter((o) => {
    const oc = compact(o.name);
    const [short, long] = c.length <= oc.length ? [c, oc] : [oc, c];
    return short.length >= 5 && long.startsWith(short);
  });
  return hits.length === 1 ? hits[0] : null;
}

export async function findOrgByName(name) {
  const { rows } = await query('SELECT * FROM organisations');
  return matchOrgName(rows, name);
}

// A UK postcode in an address, normalised ("l87ad" → "L8 7AD"), or null.
export function postcodeOf(text) {
  const m = String(text || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// Is a found past complaint one already in the system? Same organisation (by
// the rules above), and the same property postcode or raised within a fortnight
// of it. Returns the matching complaint, or null.
export function findExistingComplaint(complaints, orgs, x) {
  if (!x?.org_name) return null;
  const pc = postcodeOf(x.property);
  const raised = x.raised_on ? new Date(`${x.raised_on}T00:00:00Z`) : null;
  const sameOrg = (c) => {
    const org = c.organisation_id ? orgs.find((o) => o.id === c.organisation_id) : null;
    const names = [c.org_name, org?.name].filter(Boolean);
    return names.some((n) => matchOrgName([{ name: n }], x.org_name));
  };
  const close = (c) => {
    if (pc && postcodeOf(c.property) === pc) return true;
    if (!raised || !c.raised_on) return false;
    return Math.abs(new Date(`${c.raised_on}T00:00:00Z`) - raised) <= 14 * 86400000;
  };
  return complaints.find((c) => sameOrg(c) && close(c)) || null;
}

// Two found complaints are the same issue when they are against the same
// organisation and about the same property postcode, or raised within a
// fortnight of each other.
export function sameIssue(a, b) {
  if (!a?.org_name || !b?.org_name) return false;
  if (!matchOrgName([{ name: a.org_name }], b.org_name) && !matchOrgName([{ name: b.org_name }], a.org_name)) return false;
  const pa = postcodeOf(a.property);
  const pb = postcodeOf(b.property);
  if (pa && pb) return pa === pb;
  if (!a.raised_on || !b.raised_on) return false;
  return Math.abs(new Date(`${a.raised_on}T00:00:00Z`) - new Date(`${b.raised_on}T00:00:00Z`)) <= 14 * 86400000;
}

// Group found threads by issue (connected: if A~B and B~C, all three are one).
// Returns arrays of candidates, each group oldest first.
export function groupCandidates(cands) {
  const parent = cands.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < cands.length; i += 1) {
    for (let j = i + 1; j < cands.length; j += 1) {
      if (sameIssue(cands[i].extracted, cands[j].extracted)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  cands.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return [...groups.values()].map((g) =>
    g.sort((x, y) => String(x.extracted?.raised_on || x.first_at).localeCompare(String(y.extracted?.raised_on || y.first_at))));
}

const STAGE_ORDER = { stage_1: 1, stage_2: 2, ombudsman: 3 };
const earliest = (vals) => vals.filter(Boolean).sort()[0] || null;

// One complaint's details from several threads about it: raised on the
// earliest date, at the furthest stage any thread reached, and open or
// resolved as the most recent thread says.
export function mergeExtracted(group) {
  const xs = group.map((c) => c.extracted || {});
  const latest = [...group].sort((a, b) => new Date(b.last_at) - new Date(a.last_at))[0]?.extracted || xs[0];
  const furthest = xs.reduce((m, x) => ((STAGE_ORDER[x.stage] || 1) > (STAGE_ORDER[m.stage] || 1) ? x : m), xs[0]);
  return {
    ...xs[0],
    raised_on: earliest(xs.map((x) => x.raised_on)),
    acknowledged_on: earliest(xs.map((x) => x.acknowledged_on)),
    stage: furthest.stage || 'stage_1',
    responded_on: furthest.responded_on || null,
    reference: xs.map((x) => x.reference).find(Boolean) || null,
    property: xs.map((x) => x.property).find((p) => postcodeOf(p)) || xs[0].property || null,
    state: latest.state || 'open',
    resolved_on: latest.state === 'resolved' ? latest.resolved_on || null : null,
    summary: group.length > 1
      ? [xs[0].summary, latest !== xs[0] ? latest.summary : null].filter(Boolean).join(' Later: ')
      : xs[0].summary,
  };
}
