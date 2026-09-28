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

// Words that say what kind of body it is rather than which one. A shortened
// name matches a longer one only if all it leaves off is words like these:
// "LivingCity" is "Livingcity Asset Management Ltd", but "Liverpool" is not
// "Liverpool Mutual Homes".
const GENERIC = /^(?:ltd|plc|llp|uk|group|holdings|asset|management|services|service|property|properties|estates|council|city|borough|metropolitan|district|county|the|and|company|co|limited)*$/;

// Are two names the same organisation? Exact after cleaning, or one is the
// other with only generic words added (at least 5 letters in common).
export function sameOrgName(a, b) {
  const ka = orgKey(a);
  const kb = orgKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ca = compact(a);
  const cb = compact(b);
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return short.length >= 5 && long.startsWith(short) && GENERIC.test(long.slice(short.length));
}

// The one saved organisation a name refers to: an exact match, or else the
// only one it matches by sameOrgName. Two candidates is no match.
export function matchOrgName(orgs, name) {
  const k = orgKey(name);
  if (!k) return null;
  const exact = orgs.find((o) => orgKey(o.name) === k);
  if (exact) return exact;
  const hits = orgs.filter((o) => sameOrgName(o.name, name));
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

// The flat or house number of an address: "Apartment 309, 2 Moorfields" is
// 309, "84 Waverley Crescent" is 84, "Flat 3B" is 3B. One postcode covers a
// whole block or a stretch of street, so two addresses in it with different
// numbers are different properties (Apartment 309 and Apartment 326 at
// 2 Moorfields are two complaints, not one). Null when there isn't one.
export function unitOf(text) {
  const t = String(text || '').toUpperCase();
  const flat = t.match(/\b(?:APARTMENT|APT|FLAT|UNIT|SUITE|ROOM)\.?\s*(?:NO\.?\s*)?([A-Z]?\d+[A-Z]?)\b/);
  const lead = flat ? null : t.match(/^\s*([A-Z]?\d+[A-Z]?)\b/);
  const u = (flat || lead)?.[1];
  return u ? u.replace(/^([A-Z]?)0+(\d)/, '$1$2') : null;
}

// Same postcode AND not two different flat/house numbers.
export function sameProperty(pa, pb) {
  if (postcodeOf(pa) !== postcodeOf(pb)) return false;
  const ua = unitOf(pa);
  const ub = unitOf(pb);
  return !ua || !ub || ua === ub;
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
    return names.some((n) => sameOrgName(n, x.org_name));
  };
  const close = (c) => {
    const cpc = postcodeOf(c.property);
    if (pc && cpc) return sameProperty(x.property, c.property); // two postcodes: they decide it
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
  if (!sameOrgName(a.org_name, b.org_name)) return false;
  const pa = postcodeOf(a.property);
  const pb = postcodeOf(b.property);
  if (pa && pb) return sameProperty(a.property, b.property);
  if (!a.raised_on || !b.raised_on) return false;
  return Math.abs(new Date(`${a.raised_on}T00:00:00Z`) - new Date(`${b.raised_on}T00:00:00Z`)) <= 14 * 86400000;
}

// Group found threads by issue (connected: if A~B and B~C, all three are one).
// Returns arrays of candidates, each group oldest first.
const when = (c) => c.extracted?.raised_on || (c.first_at ? new Date(c.first_at).toISOString().slice(0, 10) : '');

// Group found threads by issue, oldest first. A thread joins a group only if
// it is the same issue as a member AND no member has a different property
// postcode or flat number — so a thread with no postcode can't bridge two
// properties into one complaint.
export function groupCandidates(cands) {
  const groups = [];
  for (const c of [...cands].sort((a, b) => when(a).localeCompare(when(b)))) {
    const prop = c.extracted?.property;
    const g = groups.find((grp) =>
      grp.some((m) => sameIssue(m.extracted, c.extracted)) &&
      grp.every((m) => {
        const mp = m.extracted?.property;
        return !postcodeOf(prop) || !postcodeOf(mp) || sameProperty(mp, prop);
      }));
    if (g) g.push(c);
    else groups.push([c]);
  }
  return groups;
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
